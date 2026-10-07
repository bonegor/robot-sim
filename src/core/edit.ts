/**
 * Pure editing operations used by the builder UI. Each returns a new
 * blueprint and leaves the input untouched, which makes undo/redo trivial.
 */
import {
  BLUEPRINT_FORMAT,
  type Blueprint,
  type DofSpec,
  type JointSpec,
  type PartSpec,
  type SnapRef,
  cloneBlueprint,
  subtreeOf,
  uniqueId,
  usedSnaps,
} from './blueprint';
import { type DriveConfig, type DriveMode, defaultDriveConfig } from './drives';
import { type JointType, getJointType } from './joints';
import { type PartType, type SnapPointDef, getPartType, getSnaps, resolveSize } from './parts';
import type { SignalSpec } from './signals';

export interface AttachResult {
  blueprint: Blueprint;
  partId: string;
  jointId?: string;
}

const OPPOSITE: Record<string, string> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
  front: 'back',
  back: 'front',
  face_top: 'face_bottom',
  face_bottom: 'face_top',
  mid_left: 'mid_right',
  mid_right: 'mid_left',
  mid_front: 'mid_back',
  mid_back: 'mid_front',
  rim_left: 'rim_right',
  rim_right: 'rim_left',
  rim_front: 'rim_back',
  rim_back: 'rim_front',
};

/** The snap on the far side of a part, handy for building chains. */
export const oppositeSnap = (snapId: string): string | undefined => OPPOSITE[snapId];

export function partSpec(bp: Blueprint, partId: string): PartSpec {
  const p = bp.parts.find((x) => x.id === partId);
  if (!p) throw new Error(`No part "${partId}"`);
  return p;
}

export function jointSpec(bp: Blueprint, jointId: string): JointSpec {
  const j = bp.joints.find((x) => x.id === jointId);
  if (!j) throw new Error(`No joint "${jointId}"`);
  return j;
}

/** The joint a part hangs off, if any. */
export const parentJointOf = (bp: Blueprint, partId: string): JointSpec | undefined => bp.joints.find((j) => j.child.part === partId);

/** Snap points of a part that are not yet connected to anything. */
export function freeSnaps(bp: Blueprint, partId: string): SnapPointDef[] {
  const part = partSpec(bp, partId);
  const used = usedSnaps(bp, partId);
  return getSnaps(part.type, resolveSize(part.type, part.size)).filter((s) => !used.has(s.id));
}

/** Starts a robot from a single part (replaces any existing parts). */
export function setRoot(bp: Blueprint, type: PartType): AttachResult {
  const next = cloneBlueprint(bp);
  const partId = uniqueId({ ...next, parts: [], joints: [] }, type);
  next.parts = [{ id: partId, type }];
  next.joints = [];
  return { blueprint: next, partId };
}

/**
 * Snaps a new part onto `target`. The child is connected by its default snap
 * (or `childSnap`) with a joint of the given type and default drives.
 */
export function attachPart(
  bp: Blueprint,
  target: SnapRef,
  type: PartType,
  jointType: JointType,
  options: { childSnap?: string; angle?: number } = {},
): AttachResult {
  partSpec(bp, target.part);
  if (usedSnaps(bp, target.part).has(target.snap)) throw new Error(`Snap "${target.snap}" on "${target.part}" is already in use`);
  const next = cloneBlueprint(bp);
  const partId = uniqueId(next, type);
  next.parts.push({ id: partId, type });
  const jointId = uniqueId(next, jointType);
  const joint: JointSpec = {
    id: jointId,
    type: jointType,
    parent: { ...target },
    child: { part: partId, snap: options.childSnap ?? getPartType(type).defaultChildSnap },
  };
  if (options.angle) joint.angle = options.angle;
  next.joints.push(joint);
  return { blueprint: next, partId, jointId };
}

/** Removes a part, everything attached below it and the joints involved. */
export function removePart(bp: Blueprint, partId: string): Blueprint {
  const doomed = subtreeOf(bp, partId);
  const next = cloneBlueprint(bp);
  next.parts = next.parts.filter((p) => !doomed.has(p.id));
  next.joints = next.joints.filter((j) => !doomed.has(j.child.part) && !doomed.has(j.parent.part));
  return next;
}

export function updatePart(bp: Blueprint, partId: string, patch: Partial<Omit<PartSpec, 'id'>>): Blueprint {
  const next = cloneBlueprint(bp);
  const part = partSpec(next, partId);
  Object.assign(part, patch);
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete part[key];
  return next;
}

export function setPartSize(bp: Blueprint, partId: string, key: string, value: number): Blueprint {
  const next = cloneBlueprint(bp);
  const part = partSpec(next, partId);
  part.size = { ...part.size, [key]: value };
  return next;
}

export function updateJoint(bp: Blueprint, jointId: string, patch: Partial<Pick<JointSpec, 'angle' | 'child'>>): Blueprint {
  const next = cloneBlueprint(bp);
  Object.assign(jointSpec(next, jointId), patch);
  return next;
}

/** Changes a joint's type, keeping the settings of DOFs that both types share. */
export function changeJointType(bp: Blueprint, jointId: string, type: JointType): Blueprint {
  const next = cloneBlueprint(bp);
  const j = jointSpec(next, jointId);
  j.type = type;
  const names = new Set(getJointType(type).dofs.map((d) => d.name));
  if (j.dofs) {
    j.dofs = Object.fromEntries(Object.entries(j.dofs).filter(([name]) => names.has(name)));
    if (Object.keys(j.dofs).length === 0) delete j.dofs;
  }
  return next;
}

export function updateDof(bp: Blueprint, jointId: string, dofName: string, patch: Partial<DofSpec>): Blueprint {
  const next = cloneBlueprint(bp);
  const j = jointSpec(next, jointId);
  const dof: DofSpec = { ...j.dofs?.[dofName], ...patch };
  for (const key of Object.keys(patch) as (keyof DofSpec)[]) if (patch[key] === undefined) delete dof[key];
  j.dofs = { ...j.dofs, [dofName]: dof };
  return next;
}

/** Switches a DOF to another drive mode, keeping its signal when going servo ↔ motor. */
export function setDriveMode(bp: Blueprint, jointId: string, dofName: string, mode: DriveMode): Blueprint {
  const j = jointSpec(bp, jointId);
  const def = getJointType(j.type).dofs.find((d) => d.name === dofName);
  if (!def) throw new Error(`Joint "${jointId}" has no "${dofName}"`);
  const current = j.dofs?.[dofName]?.drive;
  let drive: DriveConfig = defaultDriveConfig(mode, def);
  if (current && 'signal' in current && (drive.mode === 'servo' || drive.mode === 'motor')) drive = { ...drive, signal: current.signal };
  return updateDof(bp, jointId, dofName, { drive });
}

export function updateDrive(bp: Blueprint, jointId: string, dofName: string, patch: Record<string, unknown>): Blueprint {
  const j = jointSpec(bp, jointId);
  const def = getJointType(j.type).dofs.find((d) => d.name === dofName);
  if (!def) throw new Error(`Joint "${jointId}" has no "${dofName}"`);
  const current = j.dofs?.[dofName]?.drive ?? defaultDriveConfig(getJointType(j.type).defaultDrive, def);
  return updateDof(bp, jointId, dofName, { drive: { ...current, ...patch } as DriveConfig });
}

export function setSignal(bp: Blueprint, jointId: string, dofName: string, signal: SignalSpec): Blueprint {
  return updateDrive(bp, jointId, dofName, { signal });
}

/** Adds, replaces (`spec`) or deletes (`null`) a named channel. */
export function setChannel(bp: Blueprint, name: string, spec: SignalSpec | null): Blueprint {
  const next = cloneBlueprint(bp);
  const channels = { ...next.channels };
  if (spec === null) delete channels[name];
  else channels[name] = spec;
  next.channels = channels;
  return next;
}

export function renameRobot(bp: Blueprint, name: string): Blueprint {
  return { ...cloneBlueprint(bp), name };
}

/** Normalises anything that looks like a blueprint (e.g. older saves). */
export function normalizeBlueprint(bp: Blueprint): Blueprint {
  const next = cloneBlueprint(bp);
  next.format = BLUEPRINT_FORMAT;
  next.version = 1;
  next.name ||= 'Untitled robot';
  next.parts ??= [];
  next.joints ??= [];
  next.channels ??= {};
  return next;
}
