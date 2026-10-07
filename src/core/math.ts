/**
 * Minimal immutable vector / quaternion / rigid-transform helpers.
 *
 * Plain `{x,y,z}` / `{x,y,z,w}` objects are used so the values can be handed
 * directly to Rapier and three.js, and so the core stays free of any engine.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A rigid transform: rotate by `q`, then translate by `p`. */
export interface Pose {
  p: Vec3;
  q: Quat;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const ZERO: Readonly<Vec3> = Object.freeze(v3());
export const UNIT_X: Readonly<Vec3> = Object.freeze(v3(1, 0, 0));
export const UNIT_Y: Readonly<Vec3> = Object.freeze(v3(0, 1, 0));
export const UNIT_Z: Readonly<Vec3> = Object.freeze(v3(0, 0, 1));
export const QUAT_IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
export const POSE_IDENTITY: Readonly<Pose> = Object.freeze({ p: ZERO, q: QUAT_IDENTITY });

export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const neg = (a: Vec3): Vec3 => v3(-a.x, -a.y, -a.z);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) throw new Error('Cannot normalize a zero-length vector');
  return scale(a, 1 / len);
}

/** Any unit vector perpendicular to `n`. */
export function anyPerpendicular(n: Vec3): Vec3 {
  const helper = Math.abs(n.x) < 0.9 ? UNIT_X : UNIT_Y;
  return normalize(cross(n, helper));
}

export const quat = (x: number, y: number, z: number, w: number): Quat => ({ x, y, z, w });

export function qmul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export const qconj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export function qnormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-12) return { ...QUAT_IDENTITY };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/** Rotation of `angle` radians about the unit vector `axis`. */
export function qaxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalize(axis);
  const s = Math.sin(angle / 2);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angle / 2) };
}

export function qrotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w (u × v) + 2 u × (u × v), with u = (q.x, q.y, q.z)
  const u = v3(q.x, q.y, q.z);
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q.w)), cross(u, t));
}

/**
 * Rotation whose columns are the given orthonormal basis vectors, i.e. it maps
 * the local X/Y/Z axes onto `x`, `y`, `z`.
 */
export function qfromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x.x, m10 = x.y, m20 = x.z;
  const m01 = y.x, m11 = y.y, m21 = y.z;
  const m02 = z.x, m12 = z.y, m22 = z.z;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }
  return qnormalize(q);
}

/** Shortest-arc rotation taking unit vector `from` onto unit vector `to`. */
export function qfromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = dot(from, to);
  if (d < -1 + 1e-9) return qaxisAngle(anyPerpendicular(from), Math.PI);
  const c = cross(from, to);
  return qnormalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
}

/** Angle (radians, 0..π) of the rotation taking `a` to `b`. */
export function qangleBetween(a: Quat, b: Quat): number {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d));
}

/** Canonical form with w >= 0 (q and -q describe the same rotation). */
export const qcanonical = (q: Quat): Quat => (q.w < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : q);

export const pose = (p: Vec3 = ZERO, q: Quat = QUAT_IDENTITY): Pose => ({ p, q });

/** a ∘ b : first apply b, then a. */
export function composePose(a: Pose, b: Pose): Pose {
  return { p: add(a.p, qrotate(a.q, b.p)), q: qnormalize(qmul(a.q, b.q)) };
}

export function invertPose(a: Pose): Pose {
  const qi = qconj(a.q);
  return { p: neg(qrotate(qi, a.p)), q: qi };
}

export const transformPoint = (a: Pose, v: Vec3): Vec3 => add(a.p, qrotate(a.q, v));
export const transformDir = (a: Pose, v: Vec3): Vec3 => qrotate(a.q, v);

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const deg = (radians: number): number => (radians * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  if (r > Math.PI) r -= TAU;
  return r;
}
