/**
 * Building-block catalog.
 *
 * Every part is a single rigid body with one collision shape and a set of
 * snap points. A snap point is a little coordinate frame on the part surface:
 *
 *  - `position` – where on the part (local coordinates, metres)
 *  - `normal`   – outward direction; a connected part sits on this side
 *  - `up`       – a reference direction perpendicular to the normal. It fixes
 *                 the orientation of the connection, and with it the axes of
 *                 the joint (see `joints.ts`).
 *
 * Local axes follow three.js conventions: Y is "up" and the long axis of
 * rods/cylinders/discs; a robot's front faces +Z, its left side faces +X.
 */
import { type Vec3, cross, dot, length, normalize, scale, sub, v3 } from './math';

export type PartType = 'plate' | 'block' | 'rod' | 'bone' | 'cylinder' | 'disc' | 'wheel' | 'sphere';

export type Shape =
  | { kind: 'box'; halfExtents: Vec3 }
  /** Axis along local Y. */
  | { kind: 'cylinder'; halfHeight: number; radius: number; rounding?: number }
  /** Axis along local Y; `halfHeight` excludes the rounded caps. */
  | { kind: 'capsule'; halfHeight: number; radius: number }
  | { kind: 'sphere'; radius: number };

export interface SnapPointDef {
  id: string;
  label: string;
  position: Vec3;
  normal: Vec3;
  up: Vec3;
}

export interface SizeParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export type PartSize = Record<string, number>;

export interface PartTypeDef {
  type: PartType;
  label: string;
  description: string;
  /** Biological / mechanical analogue, shown in the UI. */
  analog: string;
  sizeParams: SizeParam[];
  defaultDensity: number;
  defaultFriction: number;
  defaultColor: string;
  /** Snap used on this part when it is attached to something as a child. */
  defaultChildSnap: string;
  shape(size: PartSize): Shape;
  snaps(size: PartSize): SnapPointDef[];
}

const X = v3(1, 0, 0);
const Y = v3(0, 1, 0);
const Z = v3(0, 0, 1);
const NX = v3(-1, 0, 0);
const NY = v3(0, -1, 0);
const NZ = v3(0, 0, -1);

const snap = (id: string, label: string, position: Vec3, normal: Vec3, up: Vec3): SnapPointDef => ({
  id,
  label,
  position,
  normal,
  up,
});

/** The six face-centre snaps of a box with the given half extents. */
function boxFaceSnaps(hx: number, hy: number, hz: number): SnapPointDef[] {
  return [
    snap('top', 'Top', v3(0, hy, 0), Y, Z),
    snap('bottom', 'Bottom', v3(0, -hy, 0), NY, Z),
    snap('front', 'Front', v3(0, 0, hz), Z, Y),
    snap('back', 'Back', v3(0, 0, -hz), NZ, Y),
    snap('left', 'Left side', v3(hx, 0, 0), X, Y),
    snap('right', 'Right side', v3(-hx, 0, 0), NX, Y),
  ];
}

/** End caps plus four side snaps around the middle of a Y-axis solid. */
function axialSnaps(halfLength: number, radius: number): SnapPointDef[] {
  return [
    snap('top', 'Top end', v3(0, halfLength, 0), Y, Z),
    snap('bottom', 'Bottom end', v3(0, -halfLength, 0), NY, Z),
    snap('mid_left', 'Middle, left', v3(radius, 0, 0), X, Y),
    snap('mid_right', 'Middle, right', v3(-radius, 0, 0), NX, Y),
    snap('mid_front', 'Middle, front', v3(0, 0, radius), Z, Y),
    snap('mid_back', 'Middle, back', v3(0, 0, -radius), NZ, Y),
  ];
}

/** Two face centres and four rim points of a flat Y-axis disc. */
function discSnaps(radius: number, halfThickness: number): SnapPointDef[] {
  return [
    snap('face_top', 'Top face', v3(0, halfThickness, 0), Y, Z),
    snap('face_bottom', 'Bottom face', v3(0, -halfThickness, 0), NY, Z),
    snap('rim_left', 'Rim, left', v3(radius, 0, 0), X, Y),
    snap('rim_right', 'Rim, right', v3(-radius, 0, 0), NX, Y),
    snap('rim_front', 'Rim, front', v3(0, 0, radius), Z, Y),
    snap('rim_back', 'Rim, back', v3(0, 0, -radius), NZ, Y),
  ];
}

const PLATE: PartTypeDef = {
  type: 'plate',
  label: 'Plate',
  description: 'Flat board with corner mounts underneath and wheel mounts on the sides.',
  analog: 'Torso, pelvis, chassis',
  sizeParams: [
    { key: 'width', label: 'Width (X)', min: 0.05, max: 1.5, step: 0.01, default: 0.3 },
    { key: 'thickness', label: 'Thickness (Y)', min: 0.01, max: 0.3, step: 0.005, default: 0.05 },
    { key: 'length', label: 'Length (Z)', min: 0.05, max: 2, step: 0.01, default: 0.5 },
  ],
  defaultDensity: 500,
  defaultFriction: 0.8,
  defaultColor: '#4f7cac',
  defaultChildSnap: 'bottom',
  shape: (s) => ({ kind: 'box', halfExtents: v3(s.width / 2, s.thickness / 2, s.length / 2) }),
  snaps: (s) => {
    const hx = s.width / 2;
    const hy = s.thickness / 2;
    const hz = s.length / 2;
    // Corner mounts sit slightly inside the edges; side mounts sit near the ends.
    const cx = hx - Math.min(0.03, hx * 0.2);
    const cz = hz - Math.min(0.03, hz * 0.2);
    const sz = hz * 0.65;
    const corners: [string, string, number, number][] = [
      ['fl', 'front-left', cx, cz],
      ['fr', 'front-right', -cx, cz],
      ['bl', 'back-left', cx, -cz],
      ['br', 'back-right', -cx, -cz],
    ];
    return [
      ...boxFaceSnaps(hx, hy, hz),
      ...corners.map(([id, name, x, z]) => snap(`bottom_${id}`, `Bottom ${name} corner`, v3(x, -hy, z), NY, Z)),
      ...corners.map(([id, name, x, z]) => snap(`top_${id}`, `Top ${name} corner`, v3(x, hy, z), Y, Z)),
      snap('left_front', 'Left side, front', v3(hx, 0, sz), X, Y),
      snap('left_back', 'Left side, back', v3(hx, 0, -sz), X, Y),
      snap('right_front', 'Right side, front', v3(-hx, 0, sz), NX, Y),
      snap('right_back', 'Right side, back', v3(-hx, 0, -sz), NX, Y),
    ];
  },
};

const BLOCK: PartTypeDef = {
  type: 'block',
  label: 'Block',
  description: 'Solid box with a snap point in the middle of every face.',
  analog: 'Head, hub, counterweight',
  sizeParams: [
    { key: 'x', label: 'Size X', min: 0.02, max: 1, step: 0.01, default: 0.1 },
    { key: 'y', label: 'Size Y', min: 0.02, max: 1, step: 0.01, default: 0.1 },
    { key: 'z', label: 'Size Z', min: 0.02, max: 1, step: 0.01, default: 0.1 },
  ],
  defaultDensity: 500,
  defaultFriction: 0.8,
  defaultColor: '#c9a227',
  defaultChildSnap: 'bottom',
  shape: (s) => ({ kind: 'box', halfExtents: v3(s.x / 2, s.y / 2, s.z / 2) }),
  snaps: (s) => boxFaceSnaps(s.x / 2, s.y / 2, s.z / 2),
};

const ROD: PartTypeDef = {
  type: 'rod',
  label: 'Rod',
  description: 'Thin stick with flat ends. Snap points at both ends and around the middle.',
  analog: 'Bone, strut, leg segment',
  sizeParams: [
    { key: 'length', label: 'Length', min: 0.03, max: 1.5, step: 0.01, default: 0.2 },
    { key: 'radius', label: 'Radius', min: 0.005, max: 0.1, step: 0.005, default: 0.015 },
  ],
  defaultDensity: 800,
  defaultFriction: 0.9,
  defaultColor: '#c8ccd2',
  defaultChildSnap: 'top',
  shape: (s) => ({ kind: 'cylinder', halfHeight: s.length / 2, radius: s.radius }),
  snaps: (s) => axialSnaps(s.length / 2, s.radius),
};

const BONE: PartTypeDef = {
  type: 'bone',
  label: 'Limb',
  description: 'Capsule with rounded ends; the rounded tip makes a good foot.',
  analog: 'Limb bone (femur, tibia, finger)',
  sizeParams: [
    { key: 'length', label: 'Length (tip to tip)', min: 0.04, max: 1.5, step: 0.01, default: 0.2 },
    { key: 'radius', label: 'Radius', min: 0.005, max: 0.15, step: 0.005, default: 0.02 },
  ],
  defaultDensity: 700,
  defaultFriction: 1.0,
  defaultColor: '#e8dcc4',
  defaultChildSnap: 'top',
  shape: (s) => ({ kind: 'capsule', halfHeight: Math.max(0, s.length / 2 - s.radius), radius: s.radius }),
  snaps: (s) => axialSnaps(Math.max(s.length / 2, s.radius), s.radius),
};

const CYLINDER: PartTypeDef = {
  type: 'cylinder',
  label: 'Cylinder',
  description: 'Thick cylinder with end caps and side mounts.',
  analog: 'Body segment, vertebra, barrel',
  sizeParams: [
    { key: 'length', label: 'Length', min: 0.02, max: 1.5, step: 0.01, default: 0.15 },
    { key: 'radius', label: 'Radius', min: 0.01, max: 0.5, step: 0.005, default: 0.05 },
  ],
  defaultDensity: 600,
  defaultFriction: 0.8,
  defaultColor: '#5fa8a0',
  defaultChildSnap: 'bottom',
  shape: (s) => ({ kind: 'cylinder', halfHeight: s.length / 2, radius: s.radius }),
  snaps: (s) => axialSnaps(s.length / 2, s.radius),
};

const DISC: PartTypeDef = {
  type: 'disc',
  label: 'Disc',
  description: 'Flat round plate. Mount it by a face, or by a point on its rim.',
  analog: 'Shoulder blade, kneecap, fin, foot pad',
  sizeParams: [
    { key: 'radius', label: 'Radius', min: 0.02, max: 0.8, step: 0.005, default: 0.08 },
    { key: 'thickness', label: 'Thickness', min: 0.005, max: 0.2, step: 0.005, default: 0.02 },
  ],
  defaultDensity: 700,
  defaultFriction: 0.9,
  defaultColor: '#b56576',
  defaultChildSnap: 'face_bottom',
  shape: (s) => ({ kind: 'cylinder', halfHeight: s.thickness / 2, radius: s.radius }),
  snaps: (s) => discSnaps(s.radius, s.thickness / 2),
};

const WHEEL: PartTypeDef = {
  type: 'wheel',
  label: 'Wheel',
  description: 'Grippy rounded disc meant to spin on an axle joint.',
  analog: 'Robot wheel (no direct analogue in nature)',
  sizeParams: [
    { key: 'radius', label: 'Radius', min: 0.02, max: 0.8, step: 0.005, default: 0.1 },
    { key: 'thickness', label: 'Thickness', min: 0.01, max: 0.3, step: 0.005, default: 0.04 },
  ],
  defaultDensity: 500,
  defaultFriction: 1.2,
  defaultColor: '#3a3f47',
  defaultChildSnap: 'face_bottom',
  shape: (s) => {
    const rounding = Math.min(s.thickness * 0.25, s.radius * 0.2);
    return { kind: 'cylinder', halfHeight: s.thickness / 2, radius: s.radius, rounding };
  },
  snaps: (s) => discSnaps(s.radius, s.thickness / 2).filter((p) => p.id.startsWith('face_')),
};

const SPHERE: PartTypeDef = {
  type: 'sphere',
  label: 'Ball',
  description: 'Sphere with six snap points. Useful as a foot, head or knuckle.',
  analog: 'Head, paw, knuckle',
  sizeParams: [{ key: 'radius', label: 'Radius', min: 0.01, max: 0.5, step: 0.005, default: 0.05 }],
  defaultDensity: 600,
  defaultFriction: 1.0,
  defaultColor: '#e07a5f',
  defaultChildSnap: 'top',
  shape: (s) => ({ kind: 'sphere', radius: s.radius }),
  snaps: (s) => boxFaceSnaps(s.radius, s.radius, s.radius),
};

export const PART_TYPES: Readonly<Record<PartType, PartTypeDef>> = {
  plate: PLATE,
  block: BLOCK,
  rod: ROD,
  bone: BONE,
  cylinder: CYLINDER,
  disc: DISC,
  wheel: WHEEL,
  sphere: SPHERE,
};

export const PART_TYPE_LIST: readonly PartTypeDef[] = Object.values(PART_TYPES);

export function isPartType(value: unknown): value is PartType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PART_TYPES, value);
}

export function getPartType(type: PartType): PartTypeDef {
  const def = PART_TYPES[type];
  if (!def) throw new Error(`Unknown part type "${type}"`);
  return def;
}

/** Defaults merged with overrides, each clamped to its allowed range. */
export function resolveSize(type: PartType, overrides?: Partial<PartSize>): PartSize {
  const def = getPartType(type);
  const out: PartSize = {};
  for (const p of def.sizeParams) {
    const raw = overrides?.[p.key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : p.default;
    out[p.key] = Math.min(p.max, Math.max(p.min, value));
  }
  return out;
}

export function getSnaps(type: PartType, size: PartSize): SnapPointDef[] {
  return getPartType(type).snaps(size);
}

export function findSnap(type: PartType, size: PartSize, snapId: string): SnapPointDef | undefined {
  return getSnaps(type, size).find((s) => s.id === snapId);
}

/** Volume of a shape in m³ (used for mass read-outs). */
export function shapeVolume(shape: Shape): number {
  switch (shape.kind) {
    case 'box':
      return 8 * shape.halfExtents.x * shape.halfExtents.y * shape.halfExtents.z;
    case 'cylinder':
      return Math.PI * shape.radius * shape.radius * 2 * shape.halfHeight;
    case 'capsule':
      return Math.PI * shape.radius ** 2 * 2 * shape.halfHeight + (4 / 3) * Math.PI * shape.radius ** 3;
    case 'sphere':
      return (4 / 3) * Math.PI * shape.radius ** 3;
  }
}

/** Half extents of the shape's local axis-aligned bounding box. */
export function shapeHalfExtents(shape: Shape): Vec3 {
  switch (shape.kind) {
    case 'box':
      return shape.halfExtents;
    case 'cylinder':
      return v3(shape.radius, shape.halfHeight, shape.radius);
    case 'capsule':
      return v3(shape.radius, shape.halfHeight + shape.radius, shape.radius);
    case 'sphere':
      return v3(shape.radius, shape.radius, shape.radius);
  }
}

/**
 * Signed distance from a local point to the shape surface (negative inside).
 * Used by tests to check that every snap point really sits on the surface.
 */
export function shapeSignedDistance(shape: Shape, p: Vec3): number {
  switch (shape.kind) {
    case 'box': {
      const q = v3(Math.abs(p.x) - shape.halfExtents.x, Math.abs(p.y) - shape.halfExtents.y, Math.abs(p.z) - shape.halfExtents.z);
      const outside = length(v3(Math.max(q.x, 0), Math.max(q.y, 0), Math.max(q.z, 0)));
      return outside + Math.min(Math.max(q.x, q.y, q.z), 0);
    }
    case 'cylinder': {
      // A rounded cylinder is an inner cylinder inflated by the rounding radius.
      const r = shape.rounding ?? 0;
      const radial = Math.hypot(p.x, p.z) - (shape.radius - r);
      const axial = Math.abs(p.y) - (shape.halfHeight - r);
      const outside = Math.hypot(Math.max(radial, 0), Math.max(axial, 0));
      return outside + Math.min(Math.max(radial, axial), 0) - r;
    }
    case 'capsule': {
      const y = Math.max(-shape.halfHeight, Math.min(shape.halfHeight, p.y));
      return Math.hypot(p.x, p.y - y, p.z) - shape.radius;
    }
    case 'sphere':
      return length(p) - shape.radius;
  }
}

/** Orthonormalised (normal, up, side) for a snap, robust to slightly-off input. */
export function snapBasis(s: SnapPointDef): { normal: Vec3; up: Vec3; side: Vec3 } {
  const normal = normalize(s.normal);
  const up = normalize(sub(s.up, scale(normal, dot(s.up, normal))));
  return { normal, up, side: cross(up, normal) };
}
