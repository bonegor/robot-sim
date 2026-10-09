/**
 * Physics: builds blueprints into Rapier rigid bodies and joints and runs them.
 *
 * - every part becomes one rigid body with one collider;
 * - every joint becomes one Rapier "generic" impulse joint whose local frames
 *   are exactly the assembly's joint frames, with all axes locked except the
 *   joint type's DOFs;
 * - each DOF gets a Rapier joint motor configured from its drive
 *   (free → viscous friction, spring → passive spring, servo → position
 *   target, motor → velocity target) plus its limits;
 * - every step the robot's brain turns signals into targets for the driven DOFs.
 */
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { type AssembledDof, type AssembledJoint, type AssembledPart, type Assembly, assemble, dofPositions, spawnRootPose } from '../core/assembly';
import type { Blueprint } from '../core/blueprint';
import { Brain, type BrainSenses, dofKey } from '../core/brain';
import type { BodySensorName } from '../core/expression';
import { AXIS_INDEX, type DofAxis, type DofDef } from '../core/joints';
import {
  type Pose,
  type Vec3,
  UNIT_X,
  UNIT_Y,
  UNIT_Z,
  clamp,
  composePose,
  invertPose,
  qcanonical,
  qconj,
  qmul,
  qrotate,
  v3,
  wrapAngle,
} from '../core/math';
import type { Shape } from '../core/parts';
import { type Rapier, loadRapier } from './rapier';

type World = RAPIER_NS.World;
type RigidBody = RAPIER_NS.RigidBody;
type Collider = RAPIER_NS.Collider;
type ImpulseJoint = RAPIER_NS.ImpulseJoint;

/** The parts of Rapier's raw joint API we use (it takes the same axis numbers as `JointAxis`). */
interface RawJointApi {
  jointConfigureMotorModel(handle: number, axis: number, model: number): void;
  jointConfigureMotor(handle: number, axis: number, pos: number, vel: number, stiffness: number, damping: number): void;
  jointConfigureMotorVelocity(handle: number, axis: number, vel: number, factor: number): void;
  jointConfigureMotorPosition(handle: number, axis: number, pos: number, stiffness: number, damping: number): void;
  jointSetMotorMaxForce(handle: number, axis: number, maxForce: number): void;
  jointSetLimits(handle: number, axis: number, min: number, max: number): void;
}

const LOCK_BIT: Record<DofAxis, number> = { linX: 1, linY: 2, linZ: 4, angX: 8, angY: 16, angZ: 32 };
const ALL_AXES = 63;
/** Allowed penetration between non-adjacent parts at spawn before they stop colliding with each other. */
const OVERLAP_TOLERANCE = 0.002;
/**
 * Gap (m) under which a contact point counts as touching. Rapier also reports
 * predicted contacts several centimetres away, so the distance must be checked.
 */
const TOUCH_DISTANCE = 0.003;
/**
 * Half the width of the ground slab (m), and how far the robots may wander
 * from its centre before it moves under them again. Against a much larger box
 * Rapier's contacts dip by millimetres, enough to make a wheel hop.
 */
const GROUND_HALF_SIZE = 20;
const GROUND_RECENTER = 8;

export interface SimulationOptions {
  /** Physics step in seconds (default 1/240). */
  timestep?: number;
  /** Constraint solver iterations (default 12). */
  solverIterations?: number;
  gravity?: number;
  /** Add a flat ground at y = 0 (default true). */
  ground?: boolean;
  groundFriction?: number;
}

export interface DofState {
  key: string;
  joint: string;
  def: DofDef;
  config: AssembledDof;
  axis: number;
  /** Current position (rad or m); continuous DOFs (wheels) are unwrapped. */
  position: number;
  /** Current speed (rad/s or m/s). */
  velocity: number;
  /** Target from the brain (servo: position, motor: speed), null for passive drives. */
  target: number | null;
  rawPrevious: number;
}

export interface JointState {
  id: string;
  asm: AssembledJoint;
  joint: ImpulseJoint;
  parentBody: RigidBody;
  childBody: RigidBody;
  dofs: DofState[];
  lockedLinear: number[];
  lockedAngular: number[];
}

export interface PartState {
  id: string;
  asm: AssembledPart;
  body: RigidBody;
  collider: Collider;
}

export interface RobotTelemetry {
  time: number;
  /** Horizontal distance of the root part from where it started. */
  distance: number;
  /** Displacement of the root part along the robot's initial heading. */
  forwardDistance: number;
  speed: number;
  height: number;
  /** Angle between the root part's up axis and world up, in radians. */
  tilt: number;
}

const pairKey = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class Simulation {
  readonly world: World;
  readonly timestep: number;
  readonly robots: Robot[] = [];
  /** Keys currently held (KeyboardEvent.code values). */
  readonly keys = new Set<string>();
  time = 0;
  groundCollider: Collider | null = null;

  private groundBody: RigidBody | null = null;
  private readonly excluded = new Set<string>();
  private readonly hooks: RAPIER_NS.PhysicsHooks;
  private readonly controllers: ((sim: Simulation, dt: number) => void)[] = [];
  private nextGroup = 1;

  static async create(options: SimulationOptions = {}): Promise<Simulation> {
    return new Simulation(await loadRapier(), options);
  }

  constructor(
    readonly R: Rapier,
    options: SimulationOptions = {},
  ) {
    this.world = new R.World({ x: 0, y: options.gravity ?? -9.81, z: 0 });
    this.timestep = options.timestep ?? 1 / 240;
    this.world.timestep = this.timestep;
    this.world.numSolverIterations = options.solverIterations ?? 12;
    if (options.ground ?? true) {
      this.groundBody = this.world.createRigidBody(R.RigidBodyDesc.fixed());
      this.groundCollider = this.world.createCollider(
        R.ColliderDesc.cuboid(GROUND_HALF_SIZE, 0.5, GROUND_HALF_SIZE).setTranslation(0, -0.5, 0).setFriction(options.groundFriction ?? 1),
        this.groundBody,
      );
    }
    const excluded = this.excluded;
    const COMPUTE = R.SolverFlags.COMPUTE_IMPULSE;
    this.hooks = {
      filterContactPair: (c1, c2) => (excluded.has(pairKey(c1, c2)) ? null : COMPUTE),
      filterIntersectionPair: () => true,
    };
  }

  /** Builds a robot from a blueprint and drops it into the world. */
  addRobot(bp: Blueprint, options: { rootPose?: Pose } = {}): Robot {
    const robot = new Robot(this, bp, options.rootPose ?? spawnRootPose(bp));
    this.robots.push(robot);
    return robot;
  }

  removeRobot(robot: Robot): void {
    const i = this.robots.indexOf(robot);
    if (i >= 0) this.robots.splice(i, 1);
    robot.destroy();
  }

  /**
   * Registers code that runs before every physics step — a controller written
   * in TypeScript rather than in signals. It can read sensors and steer driven
   * joints with `robot.brain.setOverride(joint, dof, value)`. Returns a function
   * that removes it again.
   */
  addController(fn: (sim: Simulation, dt: number) => void): () => void {
    this.controllers.push(fn);
    return () => {
      const i = this.controllers.indexOf(fn);
      if (i >= 0) this.controllers.splice(i, 1);
    };
  }

  /** One fixed physics step: controllers → brains → motors → solver → sensors. */
  step(): void {
    const dt = this.timestep;
    for (const c of this.controllers) c(this, dt);
    for (const r of this.robots) r.control(this.time, dt);
    this.keepGroundUnderRobots();
    this.world.step(undefined, this.hooks);
    this.time += dt;
    for (const r of this.robots) r.sense(dt);
  }

  /** Slides the ground slab under the robots; its surface stays at y = 0, so nothing standing on it notices. */
  private keepGroundUnderRobots(): void {
    const ground = this.groundBody;
    if (!ground || this.robots.length === 0) return;
    let x = 0;
    let z = 0;
    for (const r of this.robots) {
      const p = r.rootPose().p;
      x += p.x / this.robots.length;
      z += p.z / this.robots.length;
    }
    const at = ground.translation();
    if (Math.abs(x - at.x) > GROUND_RECENTER || Math.abs(z - at.z) > GROUND_RECENTER) ground.setTranslation({ x, y: at.y, z }, false);
  }

  /** Runs whole steps covering `seconds` of simulated time. */
  advance(seconds: number): void {
    const n = Math.round(seconds / this.timestep);
    for (let i = 0; i < n; i++) this.step();
  }

  dispose(): void {
    this.robots.length = 0;
    this.world.free();
  }

  /** @internal */
  excludePair(a: Collider, b: Collider): void {
    this.excluded.add(pairKey(a.handle, b.handle));
    a.setActiveHooks(this.R.ActiveHooks.FILTER_CONTACT_PAIRS);
    b.setActiveHooks(this.R.ActiveHooks.FILTER_CONTACT_PAIRS);
  }

  /** @internal Collision group bits for a robot that must not collide with itself. */
  allocateGroup(): number {
    const bit = 1 << (1 + ((this.nextGroup++ - 1) % 15));
    return ((bit & 0xffff) << 16) | (0xffff & ~bit);
  }

  /** @internal */
  rawJoints(): RawJointApi {
    return this.world.impulseJoints.raw as unknown as RawJointApi;
  }
}

/** Everything about a blueprint that cannot change while it is being simulated. */
export function structureKey(bp: Blueprint): string {
  return JSON.stringify({
    parts: bp.parts.map((p) => [p.id, p.type, p.size ?? {}, p.density ?? null, p.friction ?? null, !!p.pinned]),
    joints: bp.joints.map((j) => [j.id, j.type, j.parent, j.child, j.angle ?? 0, Object.entries(j.dofs ?? {}).map(([k, d]) => [k, d.initial ?? 0])]),
    selfCollision: bp.selfCollision ?? true,
    spawn: bp.spawn ?? null,
  });
}

export class Robot implements BrainSenses {
  assembly: Assembly;
  brain: Brain;
  readonly parts = new Map<string, PartState>();
  readonly joints = new Map<string, JointState>();
  readonly dofs = new Map<string, DofState>();
  readonly startPose: Pose;
  /** Problems found while building (e.g. overlapping parts that will not collide). */
  readonly notes: string[] = [];
  blueprint: Blueprint;

  private readonly ownColliders = new Set<number>();
  private touchCache = new Map<string, boolean>();
  private destroyed = false;

  constructor(
    readonly sim: Simulation,
    blueprint: Blueprint,
    rootPose: Pose,
  ) {
    const R = sim.R;
    const world = sim.world;
    this.blueprint = blueprint;
    this.assembly = assemble(blueprint, { rootPose });
    this.startPose = rootPose;
    this.brain = new Brain(this.assembly);
    const groups = blueprint.selfCollision === false ? sim.allocateGroup() : null;

    for (const [id, part] of this.assembly.parts) {
      const desc = (part.spec.pinned ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic().setCanSleep(false))
        .setTranslation(part.pose.p.x, part.pose.p.y, part.pose.p.z)
        .setRotation(part.pose.q);
      const body = world.createRigidBody(desc);
      const cdesc = colliderDesc(R, part.shape).setDensity(part.density).setFriction(part.friction);
      if (groups !== null) cdesc.setCollisionGroups(groups);
      const collider = world.createCollider(cdesc, body);
      this.ownColliders.add(collider.handle);
      this.parts.set(id, { id, asm: part, body, collider });
    }

    const raw = sim.rawJoints();
    const adjacent = new Set<string>();
    for (const [id, j] of this.assembly.joints) {
      const parent = this.parts.get(j.parent)!;
      const child = this.parts.get(j.child)!;
      let locked = ALL_AXES;
      for (const d of j.def.dofs) locked &= ~LOCK_BIT[d.axis];
      const data = R.JointData.generic(j.frameInParent.p, j.frameInChild.p, UNIT_X, locked as RAPIER_NS.JointAxesMask);
      const joint = world.createImpulseJoint(data, parent.body, child.body, true);
      joint.setLocalFrame1(j.frameInParent.p, j.frameInParent.q);
      joint.setLocalFrame2(j.frameInChild.p, j.frameInChild.q);
      joint.setContactsEnabled(false);
      adjacent.add(pairKey(parent.collider.handle, child.collider.handle));

      const dofs: DofState[] = j.dofs.map((cfg) => {
        const axis = AXIS_INDEX[cfg.def.axis];
        const state: DofState = {
          key: dofKey(id, cfg.def.name),
          joint: id,
          def: cfg.def,
          config: cfg,
          axis,
          position: cfg.initial,
          velocity: 0,
          target: null,
          rawPrevious: cfg.initial,
        };
        this.configureDrive(raw, joint.handle, state);
        this.dofs.set(state.key, state);
        return state;
      });
      const free = new Set(j.def.dofs.map((d) => d.axis));
      this.joints.set(id, {
        id,
        asm: j,
        joint,
        parentBody: parent.body,
        childBody: child.body,
        dofs,
        lockedLinear: (['linX', 'linY', 'linZ'] as const).filter((a) => !free.has(a)).map((a) => AXIS_INDEX[a]),
        lockedAngular: (['angX', 'angY', 'angZ'] as const).filter((a) => !free.has(a)).map((a) => AXIS_INDEX[a] - 3),
      });
    }

    // Parts that already overlap when snapped together (and are not directly
    // jointed) would explode apart, so they are told to ignore each other.
    if (groups === null) {
      const list = [...this.parts.values()];
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const ca = list[a]!.collider;
          const cb = list[b]!.collider;
          if (adjacent.has(pairKey(ca.handle, cb.handle))) continue;
          const contact = ca.contactCollider(cb, 0);
          if (contact && contact.distance < -OVERLAP_TOLERANCE) {
            sim.excludePair(ca, cb);
            this.notes.push(`"${list[a]!.id}" and "${list[b]!.id}" overlap, so they will pass through each other`);
          }
        }
      }
    }
    this.sense(0);
  }

  /**
   * Swaps in new drives, limits, signals and channels without restarting —
   * for live tuning. Returns false (and changes nothing) if the blueprint
   * differs in anything structural, which needs a fresh simulation.
   */
  retune(bp: Blueprint): boolean {
    if (structureKey(bp) !== structureKey(this.blueprint)) return false;
    const asm = assemble(bp, { rootPose: this.startPose });
    const raw = this.sim.rawJoints();
    for (const [id, j] of asm.joints) {
      const state = this.joints.get(id)!;
      state.asm = j;
      j.dofs.forEach((cfg, i) => {
        const s = state.dofs[i]!;
        s.config = cfg;
        s.target = null;
        this.configureDrive(raw, state.joint.handle, s);
      });
    }
    this.assembly = asm;
    this.blueprint = bp;
    this.brain = new Brain(asm);
    return true;
  }

  private configureDrive(raw: RawJointApi, handle: number, s: DofState): void {
    const R = this.sim.R;
    const d = s.config.drive;
    raw.jointConfigureMotorModel(handle, s.axis, R.MotorModel.ForceBased);
    const lim = s.config.limits;
    // "No limits" for a rotation is ±π: the engine compares sin(θ/2), which then never binds.
    const open = s.def.kind === 'angular' ? Math.PI : 1e6;
    raw.jointSetLimits(handle, s.axis, lim ? lim[0] : -open, lim ? lim[1] : open);
    // A Rapier motor with zero gains is not "off" but perfectly rigid, so
    // gain-less drives get a zero force budget instead.
    const UNLIMITED = Number.POSITIVE_INFINITY;
    switch (d.mode) {
      case 'free':
        raw.jointConfigureMotorVelocity(handle, s.axis, 0, d.friction);
        raw.jointSetMotorMaxForce(handle, s.axis, d.friction > 0 ? UNLIMITED : 0);
        break;
      case 'spring':
        raw.jointConfigureMotorPosition(handle, s.axis, d.rest, d.stiffness, d.damping);
        raw.jointSetMotorMaxForce(handle, s.axis, d.stiffness > 0 || d.damping > 0 ? UNLIMITED : 0);
        break;
      case 'servo':
        raw.jointConfigureMotorPosition(handle, s.axis, s.position, d.stiffness, d.damping);
        raw.jointSetMotorMaxForce(handle, s.axis, d.stiffness > 0 || d.damping > 0 ? d.maxForce : 0);
        break;
      case 'motor':
        raw.jointConfigureMotorVelocity(handle, s.axis, 0, d.gain);
        raw.jointSetMotorMaxForce(handle, s.axis, d.gain > 0 ? d.maxForce : 0);
        break;
    }
  }

  /** Runs the brain and hands the targets to the joint motors. */
  control(t: number, dt: number): void {
    if (this.destroyed) return;
    this.touchCache.clear();
    const targets = this.brain.tick(t, dt, this);
    const raw = this.sim.rawJoints();
    for (const [key, value] of targets) {
      const s = this.dofs.get(key);
      if (!s) continue;
      const handle = this.joints.get(s.joint)!.joint.handle;
      const d = s.config.drive;
      if (d.mode === 'servo') {
        const lim = s.config.limits;
        const target = lim ? clamp(value, lim[0], lim[1]) : value;
        // Feed the target's own speed forward so moving targets are tracked without lag.
        const vel = s.target === null || dt <= 0 ? 0 : clamp((target - s.target) / dt, -50, 50);
        raw.jointConfigureMotor(handle, s.axis, target, vel, d.stiffness, d.damping);
        s.target = target;
      } else if (d.mode === 'motor') {
        raw.jointConfigureMotorVelocity(handle, s.axis, value, d.gain);
        s.target = value;
      }
    }
  }

  /** Reads joint positions and speeds after a physics step. */
  sense(dt: number): void {
    for (const j of this.joints.values()) {
      const rel = this.relativeFrame(j);
      const raw = dofPositions(j.asm.def.dofs, rel);
      j.dofs.forEach((s, i) => {
        const value = raw[i]!;
        let next: number;
        if (s.config.limits === null && s.def.kind === 'angular') {
          // Continuous rotation: accumulate the wrapped change.
          next = s.position + wrapAngle(value - s.rawPrevious);
        } else next = value;
        s.velocity = dt > 0 ? (next - s.position) / dt : 0;
        s.position = next;
        s.rawPrevious = value;
      });
    }
  }

  /** Child joint frame expressed in the parent joint frame. */
  relativeFrame(j: JointState): Pose {
    const parentFrame = composePose(bodyPose(j.parentBody), j.asm.frameInParent);
    const childFrame = composePose(bodyPose(j.childBody), j.asm.frameInChild);
    return composePose(invertPose(parentFrame), childFrame);
  }

  partPose(id: string): Pose {
    const p = this.parts.get(id);
    if (!p) throw new Error(`No part "${id}"`);
    return bodyPose(p.body);
  }

  rootPose(): Pose {
    return this.partPose(this.assembly.root);
  }

  // --- BrainSenses ----------------------------------------------------------

  keyDown(code: string): boolean {
    return this.sim.keys.has(code);
  }

  private dofFor(joint: string, dof?: string): DofState | undefined {
    if (dof !== undefined) return this.dofs.get(dofKey(joint, dof));
    const j = this.joints.get(joint);
    return j?.dofs.length === 1 ? j.dofs[0] : undefined;
  }

  jointPosition(joint: string, dof?: string): number {
    return this.dofFor(joint, dof)?.position ?? 0;
  }

  jointVelocity(joint: string, dof?: string): number {
    return this.dofFor(joint, dof)?.velocity ?? 0;
  }

  /** Is the part in contact with anything outside the robot (e.g. the ground)? */
  touching(partId: string): boolean {
    const cached = this.touchCache.get(partId);
    if (cached !== undefined) return cached;
    const part = this.parts.get(partId);
    let touching = false;
    if (part) {
      this.sim.world.contactPairsWith(part.collider, (other) => {
        if (touching || this.ownColliders.has(other.handle)) return;
        this.sim.world.contactPair(part.collider, other, (manifold) => {
          for (let i = 0; i < manifold.numContacts() && !touching; i++) touching = manifold.contactDist(i) <= TOUCH_DISTANCE;
        });
      });
    }
    this.touchCache.set(partId, touching);
    return touching;
  }

  bodySensor(name: BodySensorName): number {
    const root = this.parts.get(this.assembly.root)!.body;
    const t = root.translation();
    const q = root.rotation();
    const forward = qrotate(q, UNIT_Z);
    const left = qrotate(q, UNIT_X);
    switch (name) {
      case 'roll':
        return Math.asin(clamp(left.y, -1, 1));
      case 'pitch':
        return Math.asin(clamp(forward.y, -1, 1));
      case 'yaw':
        return Math.atan2(forward.x, forward.z);
      case 'height':
        return t.y;
      case 'x':
        return t.x;
      case 'z':
        return t.z;
      case 'vx':
        return root.linvel().x;
      case 'vy':
        return root.linvel().y;
      case 'vz':
        return root.linvel().z;
      case 'speed': {
        const v = root.linvel();
        return Math.hypot(v.x, v.z);
      }
      case 'forward': {
        const v = root.linvel();
        const h = Math.hypot(forward.x, forward.z) || 1;
        return (v.x * forward.x + v.z * forward.z) / h;
      }
    }
  }

  telemetry(): RobotTelemetry {
    const root = this.rootPose();
    const start = this.startPose;
    const dx = root.p.x - start.p.x;
    const dz = root.p.z - start.p.z;
    const heading = qrotate(start.q, UNIT_Z);
    const up = qrotate(root.q, UNIT_Y);
    return {
      time: this.sim.time,
      distance: Math.hypot(dx, dz),
      forwardDistance: dx * heading.x + dz * heading.z,
      speed: this.bodySensor('speed'),
      height: root.p.y,
      tilt: Math.acos(clamp(up.y, -1, 1)),
    };
  }

  /**
   * How far each joint has drifted from a perfect connection:
   * `gap` is the displacement along locked linear axes (m),
   * `angle` the rotation about locked angular axes (rad).
   */
  connectionErrors(): { joint: string; gap: number; angle: number }[] {
    return [...this.joints.values()].map((j) => {
      const rel = this.relativeFrame(j);
      const p = [rel.p.x, rel.p.y, rel.p.z];
      const q = qcanonical(rel.q);
      const imag = [q.x, q.y, q.z];
      const gap = Math.hypot(...j.lockedLinear.map((i) => p[i]!));
      const angle = 2 * Math.asin(clamp(Math.hypot(...j.lockedAngular.map((i) => imag[i]!)), 0, 1));
      return { joint: j.id, gap, angle };
    });
  }

  /** Largest connection error over all joints. */
  worstConnection(): { gap: number; angle: number } {
    let gap = 0;
    let angle = 0;
    for (const e of this.connectionErrors()) {
      gap = Math.max(gap, e.gap);
      angle = Math.max(angle, e.angle);
    }
    return { gap, angle };
  }

  /** Total kinetic energy (J), handy to detect explosions. */
  kineticEnergy(): number {
    let e = 0;
    for (const { body } of this.parts.values()) {
      if (!body.isDynamic()) continue;
      const v = body.linvel();
      // Spin energy uses the angular velocity in the body's principal axes.
      const toPrincipal = qconj(qmul(body.rotation(), body.principalInertiaLocalFrame()));
      const w = qrotate(toPrincipal, body.angvel());
      const inertia = body.principalInertia();
      e += 0.5 * body.mass() * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * (inertia.x * w.x * w.x + inertia.y * w.y * w.y + inertia.z * w.z * w.z);
    }
    return e;
  }

  totalMass(): number {
    let m = 0;
    for (const { body } of this.parts.values()) m += body.mass();
    return m;
  }

  /** Push a part, e.g. when the user pokes it. */
  applyImpulse(partId: string, impulse: Vec3, point?: Vec3): void {
    const body = this.parts.get(partId)?.body;
    if (!body || !body.isDynamic()) return;
    if (point) body.applyImpulseAtPoint(impulse, point, true);
    else body.applyImpulse(impulse, true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const j of this.joints.values()) this.sim.world.removeImpulseJoint(j.joint, false);
    for (const p of this.parts.values()) this.sim.world.removeRigidBody(p.body);
  }
}

export function bodyPose(body: RigidBody): Pose {
  const t = body.translation();
  const r = body.rotation();
  return { p: v3(t.x, t.y, t.z), q: { x: r.x, y: r.y, z: r.z, w: r.w } };
}

function colliderDesc(R: Rapier, shape: Shape): RAPIER_NS.ColliderDesc {
  switch (shape.kind) {
    case 'box':
      return R.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
    case 'sphere':
      return R.ColliderDesc.ball(shape.radius);
    case 'capsule':
      return R.ColliderDesc.capsule(shape.halfHeight, shape.radius);
    case 'cylinder': {
      const r = shape.rounding ?? 0;
      return r > 0
        ? R.ColliderDesc.roundCylinder(shape.halfHeight - r, shape.radius - r, r)
        : R.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    }
  }
}
