/**
 * Signals: where a driven joint gets its target from.
 *
 * A signal is plain JSON so it can live inside a blueprint, be edited in the
 * UI and be saved. Signals are compiled once per simulation run into
 * closures; stateful ones (smoothed keys, toggles, filters) keep their state
 * in those closures, so a reset simply recompiles.
 */
import {
  type CompiledExpression,
  type ExpressionRuntime,
  type ExpressionScope,
  ExpressionError,
  WAVES,
  type WaveShape,
  compileExpression,
  normalizeKey,
} from './expression';

export type SignalSpec =
  /** A fixed value. */
  | { kind: 'constant'; value: number }
  /** offset + amplitude · shape(frequency · t + phase); phase is in cycles (0.5 = half a period). */
  | { kind: 'wave'; shape: WaveShape; amplitude: number; frequency: number; phase?: number; offset?: number }
  /**
   * Keyboard control. Normally rest + amount · (positive held − negative held),
   * optionally slew-limited to `rate` units/s. With `hold`, the keys instead
   * jog the value at `amount` units/s and it stays put when they are released
   * (clamped to [min, max]).
   */
  | { kind: 'keys'; positive: string; negative?: string; amount: number; rest?: number; rate?: number; hold?: boolean; min?: number; max?: number }
  /** Free-form logic, see `expression.ts`. */
  | { kind: 'expression'; expr: string }
  /** offset + gain · (a named channel of the robot's brain). */
  | { kind: 'channel'; name: string; gain?: number; offset?: number };

export type SignalKind = SignalSpec['kind'];

export interface CompiledSignal {
  /** Channels read by this signal (for evaluation order / cycle detection). */
  readonly channels: ReadonlySet<string>;
  evaluate(rt: ExpressionRuntime): number;
}

export const SIGNAL_KINDS: { kind: SignalKind; label: string; hint: string }[] = [
  { kind: 'wave', label: 'Wave', hint: 'Repeating pattern: sine, square, triangle, saw or pulse.' },
  { kind: 'keys', label: 'Keyboard', hint: 'Follows keys you hold while the simulation runs.' },
  { kind: 'expression', label: 'Logic', hint: 'A formula using time, keys, sensors and other joints.' },
  { kind: 'channel', label: 'Channel', hint: 'Re-uses a named signal shared by the whole robot.' },
  { kind: 'constant', label: 'Constant', hint: 'Holds one fixed value.' },
];

export function defaultSignal(kind: SignalKind): SignalSpec {
  switch (kind) {
    case 'constant':
      return { kind, value: 0 };
    case 'wave':
      return { kind, shape: 'sine', amplitude: 0.5, frequency: 1, phase: 0, offset: 0 };
    case 'keys':
      return { kind, positive: 'up', negative: 'down', amount: 1, rest: 0, rate: 0 };
    case 'expression':
      return { kind, expr: '0.5 * sin(2 * pi * t)' };
    case 'channel':
      return { kind, name: 'gait', gain: 1, offset: 0 };
  }
}

const finite = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

export function compileSignal(spec: SignalSpec, scope: ExpressionScope = {}): CompiledSignal {
  switch (spec.kind) {
    case 'constant': {
      const v = finite(spec.value, 0);
      return { channels: new Set(), evaluate: () => v };
    }
    case 'wave': {
      const fn = WAVES[spec.shape];
      if (!fn) throw new ExpressionError(`Unknown wave shape "${spec.shape}"`, 0);
      const amp = finite(spec.amplitude, 0);
      const freq = finite(spec.frequency, 0);
      const phase = finite(spec.phase, 0);
      const offset = finite(spec.offset, 0);
      return { channels: new Set(), evaluate: (rt) => offset + amp * fn(freq * rt.t + phase) };
    }
    case 'keys': {
      if (!spec.positive) throw new ExpressionError('Keyboard signal needs a key', 0);
      const pos = normalizeKey(spec.positive);
      const neg = spec.negative ? normalizeKey(spec.negative) : null;
      const amount = finite(spec.amount, 1);
      const rest = finite(spec.rest, 0);
      const rate = Math.max(0, finite(spec.rate, 0));
      const lo = finite(spec.min, -Infinity);
      const hi = finite(spec.max, Infinity);
      let value = rest;
      return {
        channels: new Set(),
        evaluate: (rt) => {
          const dir = (rt.keyDown(pos) ? 1 : 0) - (neg && rt.keyDown(neg) ? 1 : 0);
          if (spec.hold) {
            value = Math.min(hi, Math.max(lo, value + amount * dir * rt.dt));
            return value;
          }
          const target = rest + amount * dir;
          if (rate <= 0) value = target;
          else {
            const maxStep = rate * rt.dt;
            value += Math.max(-maxStep, Math.min(maxStep, target - value));
          }
          return value;
        },
      };
    }
    case 'expression': {
      const compiled: CompiledExpression = compileExpression(spec.expr ?? '', scope);
      return { channels: compiled.channels, evaluate: (rt) => compiled.evaluate(rt) };
    }
    case 'channel': {
      if (scope.channels && !scope.channels.has(spec.name)) throw new ExpressionError(`Unknown channel "${spec.name}"`, 0);
      const name = spec.name;
      const gain = finite(spec.gain, 1);
      const offset = finite(spec.offset, 0);
      return { channels: new Set([name]), evaluate: (rt) => offset + gain * rt.channel(name) };
    }
    default:
      throw new ExpressionError(`Unknown signal kind "${(spec as { kind: unknown }).kind}"`, 0);
  }
}

/** Error message for a signal that will not compile, or `null`. */
export function signalError(spec: SignalSpec, scope: ExpressionScope = {}): string | null {
  try {
    compileSignal(spec, scope);
    return null;
  } catch (e) {
    if (e instanceof ExpressionError) return spec.kind === 'expression' ? `${e.message} (at character ${e.position + 1})` : e.message;
    throw e;
  }
}

const fmt = (x: number | undefined, digits = 2): string => Number(finite(x, 0).toFixed(digits)).toString();

/** Short human-readable summary, e.g. "sine 0.3 @ 1.5 Hz, phase 0.5". */
export function describeSignal(spec: SignalSpec): string {
  switch (spec.kind) {
    case 'constant':
      return `constant ${fmt(spec.value)}`;
    case 'wave': {
      const parts = [`${spec.shape} ±${fmt(spec.amplitude)} @ ${fmt(spec.frequency)} Hz`];
      if (spec.phase) parts.push(`phase ${fmt(spec.phase)}`);
      if (spec.offset) parts.push(`offset ${fmt(spec.offset)}`);
      return parts.join(', ');
    }
    case 'keys':
      return spec.hold
        ? `keys ${spec.positive}${spec.negative ? `/${spec.negative}` : ''} jog ${fmt(spec.amount)}/s`
        : `keys ${spec.positive}${spec.negative ? `/${spec.negative}` : ''} → ${fmt(spec.amount)}`;
    case 'expression':
      return spec.expr;
    case 'channel':
      return `channel "${spec.name}"${finite(spec.gain, 1) !== 1 ? ` × ${fmt(spec.gain)}` : ''}${spec.offset ? ` + ${fmt(spec.offset)}` : ''}`;
  }
}
