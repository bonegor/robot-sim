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
import { type CompiledSignal, type SignalSpec, compileSignal } from './signals';

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
  /** Every compiled signal by where it sits, with the settings it came from. */
  private readonly compiled = new Map<string, { source: string; signal: CompiledSignal }>();
  private readonly scopeKey: string;

  /**
   * @param previous The brain this one replaces after a live edit. Signals
   * whose settings did not change carry on where they were (gait clocks,
   * toggles, filters), and so do overrides.
   */
  constructor(assembly: Assembly, previous?: Brain) {
    const bp = assembly.blueprint;
    const scope = blueprintScope(bp);
    // Names are looked up when a signal is compiled, so signals are only
    // reused while the same names exist.
    this.scopeKey = JSON.stringify([[...scope.channels].sort(), [...scope.joints].sort(), [...scope.parts].sort()]);
    const kept = previous?.scopeKey === this.scopeKey ? previous.compiled : undefined;
    const compile = (where: string, spec: SignalSpec): CompiledSignal => {
      const source = JSON.stringify(spec);
      const old = kept?.get(where);
      const signal = old?.source === source ? old.signal : compileSignal(spec, scope);
      this.compiled.set(where, { source, signal });
      return signal;
    };
    for (const [name, spec] of Object.entries(bp.channels ?? {})) this.channels.set(name, compile(`channel ${name}`, spec));
    for (const [jointId, joint] of assembly.joints) {
      for (const dof of joint.dofs) {
        const { mode, signal } = dof.drive;
        if (!isDriven(mode) || !signal) continue;
        const key = dofKey(jointId, dof.def.name);
        this.driven.push({ key, joint: jointId, dof: dof.def.name, mode: mode as 'servo' | 'motor', signal: compile(key, signal) });
        const override = previous?.overrides.get(key);
        if (override !== undefined) this.overrides.set(key, override);
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
