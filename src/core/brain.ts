/**
 * The brain turns signals into joint targets once per physics step.
 *
 * It owns the compiled signals of a robot: the shared named channels and the
 * signal of every driven DOF (servo → target position, motor → target speed).
 * Channels are evaluated lazily and cached for the duration of one tick, so
 * any number of joints can share e.g. one gait clock.
 *
 * The brain is engine-agnostic: it reads the world through `BrainSenses`.
 */
import type { Assembly } from './assembly';
import { blueprintScope } from './blueprint';
import { isDriven } from './drives';
import type { BodySensorName, ExpressionRuntime } from './expression';
import { type CompiledSignal, compileSignal } from './signals';

export interface BrainSenses {
  keyDown(code: string): boolean;
  jointPosition(joint: string, dof?: string): number;
  jointVelocity(joint: string, dof?: string): number;
  touching(part: string): boolean;
  bodySensor(name: BodySensorName): number;
}

export interface DrivenDof {
  /** `joint.dof` */
  key: string;
  joint: string;
  dof: string;
  mode: 'servo' | 'motor';
  signal: CompiledSignal;
}

export const dofKey = (joint: string, dof: string): string => `${joint}.${dof}`;

export class Brain {
  readonly driven: DrivenDof[] = [];
  private readonly channels = new Map<string, CompiledSignal>();
  private readonly channelCache = new Map<string, number>();
  private readonly computing = new Set<string>();
  private readonly overrides = new Map<string, number>();
  private readonly lastTargets = new Map<string, number>();

  constructor(assembly: Assembly) {
    const bp = assembly.blueprint;
    const scope = blueprintScope(bp);
    for (const [name, spec] of Object.entries(bp.channels ?? {})) this.channels.set(name, compileSignal(spec, scope));
    for (const [jointId, joint] of assembly.joints) {
      for (const dof of joint.dofs) {
        const { mode, signal } = dof.drive;
        if (!isDriven(mode) || !signal) continue;
        this.driven.push({
          key: dofKey(jointId, dof.def.name),
          joint: jointId,
          dof: dof.def.name,
          mode: mode as 'servo' | 'motor',
          signal: compileSignal(signal, scope),
        });
      }
    }
  }

  /**
   * Pins a driven DOF to a value from code, bypassing its signal
   * (pass `null` to hand control back to the signal).
   */
  setOverride(joint: string, dof: string, value: number | null): void {
    const key = dofKey(joint, dof);
    if (value === null) this.overrides.delete(key);
    else this.overrides.set(key, value);
  }

  /** Target of each driven DOF from the most recent tick. */
  targets(): ReadonlyMap<string, number> {
    return this.lastTargets;
  }

  /** Last computed value of every channel. */
  channelValues(): ReadonlyMap<string, number> {
    return this.channelCache;
  }

  /** Evaluates every driven DOF for time `t`; returns `joint.dof` → target. */
  tick(t: number, dt: number, senses: BrainSenses): ReadonlyMap<string, number> {
    this.channelCache.clear();
    const rt: ExpressionRuntime = {
      t,
      dt,
      keyDown: (code) => senses.keyDown(code),
      channel: (name) => this.channel(name, rt),
      jointPosition: (j, d) => senses.jointPosition(j, d),
      jointVelocity: (j, d) => senses.jointVelocity(j, d),
      touching: (p) => senses.touching(p),
      bodySensor: (n) => senses.bodySensor(n),
    };
    // Evaluate all channels every tick so stateful ones (toggles, filters) keep time.
    for (const name of this.channels.keys()) this.channel(name, rt);
    for (const d of this.driven) {
      const override = this.overrides.get(d.key);
      const value = override ?? d.signal.evaluate(rt);
      this.lastTargets.set(d.key, Number.isFinite(value) ? value : 0);
    }
    return this.lastTargets;
  }

  private channel(name: string, rt: ExpressionRuntime): number {
    const cached = this.channelCache.get(name);
    if (cached !== undefined) return cached;
    const sig = this.channels.get(name);
    if (!sig || this.computing.has(name)) return 0;
    this.computing.add(name);
    try {
      const v = sig.evaluate(rt);
      const value = Number.isFinite(v) ? v : 0;
      this.channelCache.set(name, value);
      return value;
    } finally {
      this.computing.delete(name);
    }
  }
}
