/**
 * Blueprint: the saveable description of a robot.
 *
 * A blueprint is a tree. The root part has no parent; every other part hangs
 * off exactly one joint, which connects a snap point on the parent to a snap
 * point on the child. Blueprints are plain JSON.
 */
import { type ExpressionScope, RESERVED_NAMES } from './expression';
import type { DriveConfig } from './drives';
import { type JointType, getJointType, isJointType } from './joints';
import type { Vec3 } from './math';
import { type PartSize, type PartType, findSnap, getPartType, isPartType, resolveSize } from './parts';
import { type SignalSpec, compileSignal, signalError } from './signals';

export const BLUEPRINT_FORMAT = 'robot-sim/blueprint';

export interface SnapRef {
  part: string;
  snap: string;
}

export interface PartSpec {
  id: string;
  type: PartType;
  size?: Partial<PartSize>;
  /** kg/m³ */
  density?: number;
  friction?: number;
  color?: string;
  /** Bolted to the world (e.g. the base of a robot arm). */
  pinned?: boolean;
}

export interface DofSpec {
  drive?: DriveConfig;
  /** Override the joint type's range; `null` removes the limits. */
  limits?: [number, number] | null;
  /** Position (rad or m) the joint starts in. */
  initial?: number;
}

export interface JointSpec {
  id: string;
  type: JointType;
  parent: SnapRef;
  child: SnapRef;
  /**
   * Rotation (rad) of the joint — and with it the child — about the
   * connection axis. Turns a hinge that swings forward into one that swings sideways.
   */
  angle?: number;
  /** Per-DOF configuration keyed by DOF name (see the joint catalog). */
  dofs?: Record<string, DofSpec>;
}

export interface SpawnSpec {
  /** Exact position of the root part. Without it the robot is placed on the ground. */
  position?: Vec3;
  /** Heading in radians about the vertical axis. */
  yaw?: number;
  /** Gap left under the lowest point when auto-placing. */
  clearance?: number;
}

export interface Blueprint {
  format: typeof BLUEPRINT_FORMAT;
  version: 1;
  name: string;
  description?: string;
  parts: PartSpec[];
  joints: JointSpec[];
  /** Named signals shared by the robot ("the brain"). */
  channels?: Record<string, SignalSpec>;
  spawn?: SpawnSpec;
  /** Whether non-adjacent parts of the robot collide with each other (default true). */
  selfCollision?: boolean;
}

export interface Issue {
  /** Where the problem is, e.g. `joints[2].child.snap`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emptyBlueprint(name = 'Untitled robot'): Blueprint {
  return { format: BLUEPRINT_FORMAT, version: 1, name, parts: [], joints: [], channels: {} };
}

/** Deep copy (blueprints are pure JSON). */
export const cloneBlueprint = (bp: Blueprint): Blueprint => JSON.parse(JSON.stringify(bp)) as Blueprint;

/** The names expressions may refer to inside this blueprint. */
export function blueprintScope(bp: Blueprint): Required<ExpressionScope> {
  const joints = new Map<string, readonly string[]>();
  for (const j of bp.joints) {
    if (isJointType(j.type)) joints.set(j.id, getJointType(j.type).dofs.map((d) => d.name));
  }
  return {
    channels: new Set(Object.keys(bp.channels ?? {})),
    joints,
    parts: new Set(bp.parts.map((p) => p.id)),
  };
}

/** The part without a parent joint (the first part if the structure is broken). */
export function findRoot(bp: Blueprint): string | undefined {
  const children = new Set(bp.joints.map((j) => j.child.part));
  return bp.parts.find((p) => !children.has(p.id))?.id ?? bp.parts[0]?.id;
}

/** Ids of `partId` and everything attached below it. */
export function subtreeOf(bp: Blueprint, partId: string): Set<string> {
  const out = new Set<string>([partId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const j of bp.joints) {
      if (out.has(j.parent.part) && !out.has(j.child.part)) {
        out.add(j.child.part);
        grew = true;
      }
    }
  }
  return out;
}

/** Snap ids on `partId` that already carry a joint. */
export function usedSnaps(bp: Blueprint, partId: string): Set<string> {
  const used = new Set<string>();
  for (const j of bp.joints) {
    if (j.parent.part === partId) used.add(j.parent.snap);
    if (j.child.part === partId) used.add(j.child.snap);
  }
  return used;
}

/** A fresh id like `rod3` that is not used by any part or joint yet. */
export function uniqueId(bp: Blueprint, base: string): string {
  const taken = new Set([...bp.parts.map((p) => p.id), ...bp.joints.map((j) => j.id)]);
  const stem = base.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, '') || 'item';
  for (let i = 1; ; i++) {
    const id = `${stem}${i}`;
    if (!taken.has(id)) return id;
  }
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function validateBlueprint(bp: Blueprint): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  if (!bp || typeof bp !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'Blueprint must be an object' }], warnings };
  }
  if (bp.format !== BLUEPRINT_FORMAT) warn('format', `Expected format "${BLUEPRINT_FORMAT}"`);
  if (!Array.isArray(bp.parts)) err('parts', 'parts must be a list');
  if (!Array.isArray(bp.joints)) err('joints', 'joints must be a list');
  if (errors.length) return { ok: false, errors, warnings };
  if (bp.parts.length === 0) err('parts', 'A robot needs at least one part');

  // --- parts -------------------------------------------------------------
  const parts = new Map<string, PartSpec>();
  const ids = new Set<string>();
  bp.parts.forEach((p, i) => {
    const path = `parts[${i}]`;
    if (typeof p.id !== 'string' || !ID_PATTERN.test(p.id)) {
      err(`${path}.id`, `Part id "${p.id}" must start with a letter and use only letters, digits, "_" or "-"`);
      return;
    }
    if (ids.has(p.id)) err(`${path}.id`, `Duplicate id "${p.id}"`);
    ids.add(p.id);
    if (!isPartType(p.type)) {
      err(`${path}.type`, `Unknown part type "${p.type}"`);
      return;
    }
    parts.set(p.id, p);
    const def = getPartType(p.type);
    for (const [key, value] of Object.entries(p.size ?? {})) {
      const param = def.sizeParams.find((s) => s.key === key);
      if (!param) warn(`${path}.size.${key}`, `${def.label} has no size "${key}"`);
      else if (!isFiniteNumber(value)) err(`${path}.size.${key}`, `Size "${key}" must be a number`);
      else if (value < param.min || value > param.max) {
        warn(`${path}.size.${key}`, `${param.label} ${value} is outside ${param.min}–${param.max} and will be clamped`);
      }
    }
    if (p.density !== undefined && (!isFiniteNumber(p.density) || p.density <= 0)) err(`${path}.density`, 'Density must be a positive number');
    if (p.friction !== undefined && (!isFiniteNumber(p.friction) || p.friction < 0)) err(`${path}.friction`, 'Friction must be zero or more');
  });

  // --- joints ------------------------------------------------------------
  const parentOf = new Map<string, string>();
  const snapUse = new Map<string, string>();
  const scope = blueprintScope(bp);
  bp.joints.forEach((j, i) => {
    const path = `joints[${i}]`;
    if (typeof j.id !== 'string' || !ID_PATTERN.test(j.id)) {
      err(`${path}.id`, `Joint id "${j.id}" must start with a letter and use only letters, digits, "_" or "-"`);
      return;
    }
    if (ids.has(j.id)) err(`${path}.id`, `Duplicate id "${j.id}"`);
    ids.add(j.id);
    if (!isJointType(j.type)) {
      err(`${path}.type`, `Unknown joint type "${j.type}"`);
      return;
    }
    const jdef = getJointType(j.type);
    let endsOk = true;
    for (const side of ['parent', 'child'] as const) {
      const ref = j[side];
      const part = ref && parts.get(ref.part);
      if (!ref || !part) {
        err(`${path}.${side}.part`, `Unknown part "${ref?.part}"`);
        endsOk = false;
        continue;
      }
      const size = resolveSize(part.type, part.size);
      if (!findSnap(part.type, size, ref.snap)) {
        const available = getPartType(part.type).snaps(size).map((s) => s.id);
        err(`${path}.${side}.snap`, `${getPartType(part.type).label} "${part.id}" has no snap point "${ref.snap}" (try: ${available.join(', ')})`);
        endsOk = false;
        continue;
      }
      const key = `${ref.part}/${ref.snap}`;
      const other = snapUse.get(key);
      if (other) err(`${path}.${side}.snap`, `Snap point "${ref.snap}" on "${ref.part}" is already used by joint "${other}"`);
      else snapUse.set(key, j.id);
    }
    if (endsOk && j.parent.part === j.child.part) err(path, `Joint "${j.id}" connects part "${j.parent.part}" to itself`);
    if (endsOk) {
      const existing = parentOf.get(j.child.part);
      if (existing) err(`${path}.child.part`, `Part "${j.child.part}" already hangs off joint "${existing}"; a part can only have one parent`);
      else parentOf.set(j.child.part, j.id);
    }
    if (j.angle !== undefined && !isFiniteNumber(j.angle)) err(`${path}.angle`, 'Joint angle must be a number (radians)');

    for (const [dofName, dof] of Object.entries(j.dofs ?? {})) {
      const dpath = `${path}.dofs.${dofName}`;
      const ddef = jdef.dofs.find((d) => d.name === dofName);
      if (!ddef) {
        err(dpath, `${jdef.label} joint has no "${dofName}" (it has: ${jdef.dofs.map((d) => d.name).join(', ') || 'none'})`);
        continue;
      }
      if (dof.limits !== undefined && dof.limits !== null) {
        const [lo, hi] = dof.limits;
        if (!isFiniteNumber(lo) || !isFiniteNumber(hi) || lo > hi) err(`${dpath}.limits`, 'Limits must be [min, max] with min ≤ max');
      }
      const limits = dof.limits === undefined ? ddef.limits : dof.limits;
      if (dof.initial !== undefined) {
        if (!isFiniteNumber(dof.initial)) err(`${dpath}.initial`, 'Initial position must be a number');
        else if (limits && (dof.initial < limits[0] - 1e-9 || dof.initial > limits[1] + 1e-9)) {
          warn(`${dpath}.initial`, `Initial position ${dof.initial} is outside the limits and will be clamped`);
        }
      }
      const drive = dof.drive;
      if (drive) {
        if (!['free', 'spring', 'servo', 'motor'].includes(drive.mode)) err(`${dpath}.drive.mode`, `Unknown drive mode "${(drive as { mode: string }).mode}"`);
        for (const key of ['friction', 'stiffness', 'damping', 'gain', 'maxForce'] as const) {
          const value = (drive as Record<string, unknown>)[key];
          if (value !== undefined && (!isFiniteNumber(value) || value < 0)) err(`${dpath}.drive.${key}`, `${key} must be zero or more`);
        }
        if (drive.mode === 'servo' || drive.mode === 'motor') {
          if (!drive.signal) err(`${dpath}.drive.signal`, `A ${drive.mode} needs a signal to follow`);
          else {
            const msg = signalError(drive.signal, scope);
            if (msg) err(`${dpath}.drive.signal`, msg);
          }
        }
      }
    }
  });

  // --- tree structure ----------------------------------------------------
  if (errors.length === 0 && bp.parts.length > 0) {
    const roots = bp.parts.filter((p) => !parentOf.has(p.id));
    if (roots.length === 0) err('joints', 'The joints form a loop: every part has a parent, so there is no root part');
    else {
      const root = roots[0]!.id;
      const reached = subtreeOf(bp, root);
      bp.parts.forEach((p, i) => {
        if (!reached.has(p.id)) {
          err(`parts[${i}]`, parentOf.has(p.id) ? `Part "${p.id}" is part of a loop of joints` : `Part "${p.id}" is not connected to "${root}"`);
        }
      });
    }
  }

  // --- channels ----------------------------------------------------------
  const channels = bp.channels ?? {};
  const deps = new Map<string, Set<string>>();
  for (const [name, spec] of Object.entries(channels)) {
    const path = `channels.${name}`;
    if (!CHANNEL_PATTERN.test(name)) err(path, `Channel name "${name}" must be a simple word (letters, digits, "_")`);
    else if (RESERVED_NAMES.has(name)) err(path, `"${name}" is a built-in name; pick another channel name`);
    const msg = signalError(spec, scope);
    if (msg) err(path, msg);
    else deps.set(name, new Set(compileSignal(spec, scope).channels));
  }
  const cycle = findChannelCycle(deps);
  if (cycle) err(`channels.${cycle[0]}`, `Channels depend on each other in a loop: ${cycle.join(' → ')}`);

  if (bp.spawn?.position) {
    const p = bp.spawn.position;
    if (![p.x, p.y, p.z].every(isFiniteNumber)) err('spawn.position', 'Spawn position must be three numbers');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Returns one dependency cycle (as a list of names, first repeated at the end) or null. */
export function findChannelCycle(deps: ReadonlyMap<string, ReadonlySet<string>>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    const s = state.get(name);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(name)), name];
    state.set(name, 'visiting');
    stack.push(name);
    for (const d of deps.get(name) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  };
  for (const name of deps.keys()) {
    const c = visit(name);
    if (c) return c;
  }
  return null;
}

export class BlueprintError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`Invalid blueprint:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'BlueprintError';
  }
}

/** Parses JSON text into a blueprint, throwing a readable error if it is not one. */
export function parseBlueprint(json: string): Blueprint {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new BlueprintError([{ path: '', message: `Not valid JSON: ${(e as Error).message}` }]);
  }
  const bp = data as Blueprint;
  const res = validateBlueprint(bp);
  if (!res.ok) throw new BlueprintError(res.errors);
  return bp;
}

export const serializeBlueprint = (bp: Blueprint): string => JSON.stringify(bp, null, 2);

/** Keys a blueprint listens to (as written in its signals), for on-screen hints. */
export function keysUsed(bp: Blueprint): string[] {
  const keys = new Set<string>();
  const visit = (spec: SignalSpec) => {
    if (spec.kind === 'keys') {
      keys.add(spec.positive);
      if (spec.negative) keys.add(spec.negative);
    }
    if (spec.kind === 'expression') {
      for (const m of spec.expr.matchAll(/\b(?:key|pressed|axis|toggle)\s*\(([^)]*)\)/g)) {
        for (const k of m[1]!.matchAll(/["']([^"']+)["']/g)) keys.add(k[1]!);
      }
    }
  };
  for (const spec of Object.values(bp.channels ?? {})) visit(spec);
  for (const j of bp.joints) for (const d of Object.values(j.dofs ?? {})) if (d.drive && 'signal' in d.drive) visit(d.drive.signal);
  const pretty: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→', space: 'Space' };
  return [...new Set([...keys].map((k) => pretty[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k)))];
}
