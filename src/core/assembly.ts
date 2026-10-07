/**
 * Snap assembly: turns a blueprint into posed parts and joint frames.
 *
 * Starting at the root part, every child is placed so that
 *   - its snap point coincides with the parent's snap point,
 *   - its snap normal points straight back at the parent (normals opposite),
 *   - its snap "up" matches the joint frame's Y axis (after the joint `angle`),
 *   - and then the joint's initial DOF positions are applied.
 *
 * The joint frame (see joints.ts) is reported in both parts' local
 * coordinates; these are exactly the frames the physics joint uses, so a DOF
 * reading of zero always means "as snapped together".
 */
import { type Blueprint, BlueprintError, type DofSpec, type JointSpec, type PartSpec, findRoot, validateBlueprint } from './blueprint';
import { type ResolvedDrive, resolveDrive } from './drives';
import { type DofDef, type JointTypeDef, getJointType } from './joints';
import {
  type Pose,
  type Quat,
  type Vec3,
  POSE_IDENTITY,
  UNIT_Y,
  UNIT_Z,
  clamp,
  composePose,
  dot,
  invertPose,
  qaxisAngle,
  qcanonical,
  qconj,
  qfromBasis,
  qmul,
  qnormalize,
  qrotate,
  transformDir,
  transformPoint,
  v3,
} from './math';
import {
  type PartSize,
  type PartTypeDef,
  type Shape,
  type SnapPointDef,
  findSnap,
  getPartType,
  resolveSize,
  snapBasis,
} from './parts';

export interface AssembledPart {
  spec: PartSpec;
  def: PartTypeDef;
  size: PartSize;
  shape: Shape;
  /** World pose of the part centre. */
  pose: Pose;
  density: number;
  friction: number;
  color: string;
  /** Joint this part hangs off (undefined for the root). */
  parentJoint?: string;
  depth: number;
}

export interface AssembledDof {
  def: DofDef;
  limits: [number, number] | null;
  initial: number;
  drive: ResolvedDrive;
}

export interface AssembledJoint {
  spec: JointSpec;
  def: JointTypeDef;
  parent: string;
  child: string;
  /** Joint frame in the parent's local coordinates. */
  frameInParent: Pose;
  /** Joint frame in the child's local coordinates (at DOF positions = 0). */
  frameInChild: Pose;
  /** Joint frame in world coordinates (attached to the parent). */
  worldFrame: Pose;
  dofs: AssembledDof[];
}

export interface Assembly {
  blueprint: Blueprint;
  root: string;
  /** Parts in parent-before-child order. */
  parts: Map<string, AssembledPart>;
  joints: Map<string, AssembledJoint>;
}

export interface AssembleOptions {
  /** World pose of the root part (identity by default). */
  rootPose?: Pose;
  /** Override DOF positions: joint id → DOF name → value. Defaults to each DOF's `initial`. */
  configuration?: Record<string, Record<string, number>>;
  /** Skip validation (the caller already validated). */
  trusted?: boolean;
}

/** Snap frame as a pose in part-local coordinates: Z = normal, Y = up, X = up × normal. */
export function snapFrame(snap: SnapPointDef): Pose {
  const { normal, up, side } = snapBasis(snap);
  return { p: snap.position, q: qfromBasis(side, up, normal) };
}

/** Half-turn about Y: maps a frame's Z onto −Z while keeping Y. */
const FLIP: Quat = { x: 0, y: 1, z: 0, w: 0 };

/**
 * Relative transform of the child's joint frame for the given DOF positions,
 * using the same convention as the physics engine: linear coordinates are
 * measured in the parent joint frame; each angular coordinate θ contributes
 * sin(θ/2) to the matching imaginary part of the relative rotation.
 */
export function dofTransform(dofs: readonly Pick<DofDef, 'axis'>[], values: readonly number[]): Pose {
  const lin = [0, 0, 0];
  const s = [0, 0, 0];
  dofs.forEach((d, i) => {
    const v = values[i] ?? 0;
    switch (d.axis) {
      case 'linX':
        lin[0] = v;
        break;
      case 'linY':
        lin[1] = v;
        break;
      case 'linZ':
        lin[2] = v;
        break;
      case 'angX':
        s[0] = Math.sin(v / 2);
        break;
      case 'angY':
        s[1] = Math.sin(v / 2);
        break;
      case 'angZ':
        s[2] = Math.sin(v / 2);
        break;
    }
  });
  // A single angular DOF may exceed ±π (e.g. a wheel); use the exact quaternion then.
  const angular = dofs.map((d, i) => ({ d, v: values[i] ?? 0 })).filter((x) => x.d.axis.startsWith('ang'));
  let q: Quat;
  if (angular.length === 1) {
    const { d, v } = angular[0]!;
    const axis = d.axis === 'angX' ? v3(1, 0, 0) : d.axis === 'angY' ? v3(0, 1, 0) : v3(0, 0, 1);
    q = qaxisAngle(axis, v);
  } else {
    const ss = s[0]! ** 2 + s[1]! ** 2 + s[2]! ** 2;
    q = qnormalize({ x: s[0]!, y: s[1]!, z: s[2]!, w: Math.sqrt(Math.max(0, 1 - ss)) });
  }
  return { p: v3(lin[0], lin[1], lin[2]), q };
}

/**
 * Inverse of `dofTransform`: reads DOF positions from the relative transform
 * between the two joint frames (child frame expressed in the parent frame).
 */
export function dofPositions(dofs: readonly Pick<DofDef, 'axis'>[], rel: Pose): number[] {
  const q = qcanonical(rel.q);
  // With a single rotational DOF the angle is exact over the full circle.
  const single = dofs.filter((d) => d.axis.startsWith('ang')).length === 1;
  const ang = (c: number) => (single ? 2 * Math.atan2(c, q.w) : 2 * Math.asin(clamp(c, -1, 1)));
  return dofs.map((d) => {
    switch (d.axis) {
      case 'linX':
        return rel.p.x;
      case 'linY':
        return rel.p.y;
      case 'linZ':
        return rel.p.z;
      case 'angX':
        return ang(q.x);
      case 'angY':
        return ang(q.y);
      case 'angZ':
        return ang(q.z);
    }
  });
}

/** World pose of a part's snap frame. */
export function snapWorldFrame(part: AssembledPart, snapId: string): Pose {
  const snap = findSnap(part.spec.type, part.size, snapId);
  if (!snap) throw new Error(`Part "${part.spec.id}" has no snap "${snapId}"`);
  return composePose(part.pose, snapFrame(snap));
}

function resolveDofs(spec: JointSpec, def: JointTypeDef): AssembledDof[] {
  return def.dofs.map((d) => {
    const ds: DofSpec = spec.dofs?.[d.name] ?? {};
    const limits = ds.limits === undefined ? d.limits : ds.limits;
    let initial = typeof ds.initial === 'number' && Number.isFinite(ds.initial) ? ds.initial : 0;
    if (limits) initial = clamp(initial, limits[0], limits[1]);
    return { def: d, limits: limits ? [limits[0], limits[1]] : null, initial, drive: resolveDrive(ds.drive, d, def.defaultDrive) };
  });
}

export function assemble(bp: Blueprint, options: AssembleOptions = {}): Assembly {
  if (!options.trusted) {
    const res = validateBlueprint(bp);
    if (!res.ok) throw new BlueprintError(res.errors);
  }
  const root = findRoot(bp);
  if (!root) throw new BlueprintError([{ path: 'parts', message: 'A robot needs at least one part' }]);

  const specs = new Map(bp.parts.map((p) => [p.id, p]));
  const childJoints = new Map<string, JointSpec[]>();
  for (const j of bp.joints) {
    const list = childJoints.get(j.parent.part) ?? [];
    list.push(j);
    childJoints.set(j.parent.part, list);
  }

  const makePart = (spec: PartSpec, pose: Pose, depth: number, parentJoint?: string): AssembledPart => {
    const def = getPartType(spec.type);
    const size = resolveSize(spec.type, spec.size);
    return {
      spec,
      def,
      size,
      shape: def.shape(size),
      pose,
      density: spec.density ?? def.defaultDensity,
      friction: spec.friction ?? def.defaultFriction,
      color: spec.color ?? def.defaultColor,
      depth,
      ...(parentJoint ? { parentJoint } : {}),
    };
  };

  const parts = new Map<string, AssembledPart>();
  const joints = new Map<string, AssembledJoint>();
  parts.set(root, makePart(specs.get(root)!, options.rootPose ?? POSE_IDENTITY, 0));

  const queue = [root];
  while (queue.length) {
    const parentId = queue.shift()!;
    const parent = parts.get(parentId)!;
    for (const j of childJoints.get(parentId) ?? []) {
      const def = getJointType(j.type);
      const childSpec = specs.get(j.child.part)!;
      const childSize = resolveSize(childSpec.type, childSpec.size);
      const parentSnap = findSnap(parent.spec.type, parent.size, j.parent.snap)!;
      const childSnap = findSnap(childSpec.type, childSize, j.child.snap)!;

      // Joint frame: the parent's snap frame turned by `angle` about its normal.
      const spin: Pose = { p: v3(), q: qaxisAngle(UNIT_Z, j.angle ?? 0) };
      const frameInParent = composePose(snapFrame(parentSnap), spin);
      const worldFrame = composePose(parent.pose, frameInParent);
      // The child's snap frame is the joint frame flipped half a turn about Y.
      const frameInChild = composePose(snapFrame(childSnap), { p: v3(), q: qconj(FLIP) });

      const dofs = resolveDofs(j, def);
      const config = options.configuration?.[j.id];
      const values = dofs.map((d) => config?.[d.def.name] ?? d.initial);
      const childFrameWorld = composePose(worldFrame, dofTransform(def.dofs, values));
      const childPose = composePose(childFrameWorld, invertPose(frameInChild));

      const child = makePart(childSpec, childPose, parent.depth + 1, j.id);
      parts.set(childSpec.id, child);
      joints.set(j.id, { spec: j, def, parent: parentId, child: childSpec.id, frameInParent, frameInChild, worldFrame, dofs });
      queue.push(childSpec.id);
    }
  }
  return { blueprint: bp, root, parts, joints };
}

/** World-space axis-aligned bounds of a posed shape. */
export function shapeWorldBounds(shape: Shape, pose: Pose): { min: Vec3; max: Vec3 } {
  let ext: Vec3;
  if (shape.kind === 'box') {
    const h = shape.halfExtents;
    const ax = transformDir(pose, v3(h.x, 0, 0));
    const ay = transformDir(pose, v3(0, h.y, 0));
    const az = transformDir(pose, v3(0, 0, h.z));
    ext = v3(
      Math.abs(ax.x) + Math.abs(ay.x) + Math.abs(az.x),
      Math.abs(ax.y) + Math.abs(ay.y) + Math.abs(az.y),
      Math.abs(ax.z) + Math.abs(ay.z) + Math.abs(az.z),
    );
  } else if (shape.kind === 'sphere') {
    ext = v3(shape.radius, shape.radius, shape.radius);
  } else {
    // Cylinder or capsule around the local Y axis: |axis component| · half height
    // plus the radius of the end disc (cylinder) or end sphere (capsule).
    const a = qrotate(pose.q, UNIT_Y);
    const h = shape.halfHeight;
    const r = shape.radius;
    const extent = (c: number) => Math.abs(c) * h + (shape.kind === 'capsule' ? r : r * Math.sqrt(Math.max(0, 1 - c * c)));
    ext = v3(extent(a.x), extent(a.y), extent(a.z));
  }
  return {
    min: v3(pose.p.x - ext.x, pose.p.y - ext.y, pose.p.z - ext.z),
    max: v3(pose.p.x + ext.x, pose.p.y + ext.y, pose.p.z + ext.z),
  };
}

export function assemblyBounds(asm: Assembly): { min: Vec3; max: Vec3 } {
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const part of asm.parts.values()) {
    const b = shapeWorldBounds(part.shape, part.pose);
    min.x = Math.min(min.x, b.min.x);
    min.y = Math.min(min.y, b.min.y);
    min.z = Math.min(min.z, b.min.z);
    max.x = Math.max(max.x, b.max.x);
    max.y = Math.max(max.y, b.max.y);
    max.z = Math.max(max.z, b.max.z);
  }
  return { min, max };
}

/**
 * Pose for the root so the robot stands on the ground (y = 0) with the given
 * clearance, centred over the origin, facing `yaw` — unless the blueprint
 * pins an exact spawn position.
 */
export function spawnRootPose(bp: Blueprint): Pose {
  const yawQ = qaxisAngle(UNIT_Y, bp.spawn?.yaw ?? 0);
  if (bp.spawn?.position) return { p: bp.spawn.position, q: yawQ };
  const pinned = bp.parts.some((p) => p.pinned);
  const clearance = bp.spawn?.clearance ?? (pinned ? 0 : 0.02);
  const local = assemble(bp, { rootPose: { p: v3(), q: yawQ }, trusted: true });
  const b = assemblyBounds(local);
  return { p: v3(-(b.min.x + b.max.x) / 2, clearance - b.min.y, -(b.min.z + b.max.z) / 2), q: yawQ };
}

/** Measures how well two parts are snapped together at a joint (for tests and debugging). */
export function snapAlignment(asm: Assembly, jointId: string): { gap: number; normalDot: number; upDot: number } {
  const j = asm.joints.get(jointId);
  if (!j) throw new Error(`No joint "${jointId}"`);
  const parent = asm.parts.get(j.parent)!;
  const child = asm.parts.get(j.child)!;
  const a = snapWorldFrame(parent, j.spec.parent.snap);
  const b = snapWorldFrame(child, j.spec.child.snap);
  const pa = transformPoint(a, v3());
  const pb = transformPoint(b, v3());
  return {
    gap: Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z),
    normalDot: dot(qrotate(a.q, UNIT_Z), qrotate(b.q, UNIT_Z)),
    upDot: dot(qrotate(qmul(a.q, qaxisAngle(UNIT_Z, j.spec.angle ?? 0)), UNIT_Y), qrotate(b.q, UNIT_Y)),
  };
}
