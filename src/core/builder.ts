/**
 * Fluent helper for writing blueprints in code (presets, tests):
 *
 *   const bp = new RobotBuilder('Pendulum')
 *     .root('base', 'block', { pinned: true })
 *     .attach('swing', 'hinge', 'base.bottom', { id: 'arm', type: 'rod' })
 *     .build();
 */
import {
  BLUEPRINT_FORMAT,
  type Blueprint,
  BlueprintError,
  type DofSpec,
  type JointSpec,
  type PartSpec,
  type SnapRef,
  type SpawnSpec,
  validateBlueprint,
} from './blueprint';
import type { JointType } from './joints';
import { type PartType, getPartType } from './parts';
import type { SignalSpec } from './signals';

export type PartOptions = Omit<PartSpec, 'id' | 'type'>;

export interface ChildOptions extends PartOptions {
  id: string;
  type: PartType;
  /** Snap on the child used for the connection (defaults to the part type's default). */
  snap?: string;
}

export interface JointOptions {
  angle?: number;
  dofs?: Record<string, DofSpec>;
}

const parseRef = (ref: string | SnapRef): SnapRef => {
  if (typeof ref !== 'string') return ref;
  const dot = ref.indexOf('.');
  if (dot < 0) throw new Error(`Snap reference "${ref}" should look like "part.snap"`);
  return { part: ref.slice(0, dot), snap: ref.slice(dot + 1) };
};

export class RobotBuilder {
  private readonly bp: Blueprint;

  constructor(name: string, description?: string) {
    this.bp = { format: BLUEPRINT_FORMAT, version: 1, name, parts: [], joints: [], channels: {} };
    if (description) this.bp.description = description;
  }

  root(id: string, type: PartType, options: PartOptions = {}): this {
    if (this.bp.parts.length) throw new Error('root() must be called first, and only once');
    this.bp.parts.push({ id, type, ...options });
    return this;
  }

  attach(jointId: string, jointType: JointType, parent: string | SnapRef, child: ChildOptions, options: JointOptions = {}): this {
    const { id, type, snap, ...partOptions } = child;
    this.bp.parts.push({ id, type, ...partOptions });
    const joint: JointSpec = {
      id: jointId,
      type: jointType,
      parent: parseRef(parent),
      child: { part: id, snap: snap ?? getPartType(type).defaultChildSnap },
    };
    if (options.angle !== undefined) joint.angle = options.angle;
    if (options.dofs) joint.dofs = options.dofs;
    this.bp.joints.push(joint);
    return this;
  }

  channel(name: string, signal: SignalSpec): this {
    this.bp.channels = { ...this.bp.channels, [name]: signal };
    return this;
  }

  spawn(spawn: SpawnSpec): this {
    this.bp.spawn = spawn;
    return this;
  }

  selfCollision(enabled: boolean): this {
    this.bp.selfCollision = enabled;
    return this;
  }

  /** Returns the blueprint, throwing if it is invalid. */
  build(): Blueprint {
    const res = validateBlueprint(this.bp);
    if (!res.ok) throw new BlueprintError(res.errors);
    return JSON.parse(JSON.stringify(this.bp)) as Blueprint;
  }

  /** Returns the blueprint without validating it (for tests of invalid input). */
  draft(): Blueprint {
    return JSON.parse(JSON.stringify(this.bp)) as Blueprint;
  }
}
