/**
 * Drives decide how each degree of freedom of a joint behaves:
 *
 *  - free   — hangs loose and flaps around (only a touch of friction)
 *  - spring — passive and elastic: pulls back towards a rest position
 *  - servo  — actively follows a signal as a target *position* (angle / extension)
 *  - motor  — actively follows a signal as a target *speed* (e.g. a wheel)
 *
 * The first two are passive; the last two are "driven" and read a signal.
 * Units: angular DOFs use N·m, rad, rad/s; linear DOFs use N, m, m/s.
 */
import type { DefaultDriveMode, DofDef } from './joints';
import type { SignalSpec } from './signals';

export type DriveMode = 'free' | 'spring' | 'servo' | 'motor';

export type DriveConfig =
  | { mode: 'free'; friction?: number }
  | { mode: 'spring'; stiffness?: number; damping?: number; rest?: number }
  | { mode: 'servo'; signal: SignalSpec; stiffness?: number; damping?: number; maxForce?: number }
  | { mode: 'motor'; signal: SignalSpec; gain?: number; maxForce?: number };

export interface ResolvedDrive {
  mode: DriveMode;
  /** Viscous friction used by free joints. */
  friction: number;
  /** Position gain (spring / servo). */
  stiffness: number;
  /** Velocity damping (spring / servo). */
  damping: number;
  /** Spring rest position. */
  rest: number;
  /** Velocity gain (motor). */
  gain: number;
  /** Strength limit: the largest torque / force the drive can apply. */
  maxForce: number;
  signal?: SignalSpec;
}

export const DRIVE_MODES: { mode: DriveMode; label: string; passive: boolean; hint: string }[] = [
  { mode: 'free', label: 'Free', passive: true, hint: 'Floppy: swings freely under gravity and contact.' },
  { mode: 'spring', label: 'Spring', passive: true, hint: 'Elastic: springs back to its rest position, like a tendon.' },
  { mode: 'servo', label: 'Servo', passive: false, hint: 'Driven: moves to the position given by its signal.' },
  { mode: 'motor', label: 'Motor', passive: false, hint: 'Driven: spins / slides at the speed given by its signal.' },
];

/** Defaults sized for robots of roughly 1–10 kg built from the stock parts. */
export const DRIVE_DEFAULTS: Record<'angular' | 'linear', Omit<ResolvedDrive, 'mode' | 'signal' | 'rest'>> = {
  angular: { friction: 0.005, stiffness: 300, damping: 6, gain: 5, maxForce: 20 },
  linear: { friction: 0.2, stiffness: 3000, damping: 60, gain: 50, maxForce: 300 },
};

export const SPRING_DEFAULTS: Record<'angular' | 'linear', { stiffness: number; damping: number }> = {
  angular: { stiffness: 8, damping: 0.25 },
  linear: { stiffness: 400, damping: 10 },
};

const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const nonNeg = (x: unknown, fallback: number): number => Math.max(0, num(x, fallback));

export function defaultDriveConfig(mode: DriveMode | DefaultDriveMode, dof: Pick<DofDef, 'kind'>): DriveConfig {
  switch (mode) {
    case 'free':
      return { mode: 'free' };
    case 'spring':
      return { mode: 'spring', ...SPRING_DEFAULTS[dof.kind], rest: 0 };
    case 'servo':
      return {
        mode: 'servo',
        signal: { kind: 'wave', shape: 'sine', amplitude: dof.kind === 'angular' ? 0.5 : 0.05, frequency: 1, phase: 0, offset: 0 },
      };
    case 'motor':
      return { mode: 'motor', signal: { kind: 'keys', positive: 'up', negative: 'down', amount: dof.kind === 'angular' ? 8 : 0.2 } };
  }
}

/** Fills in every number so the physics layer never has to guess. */
export function resolveDrive(config: DriveConfig | undefined, dof: Pick<DofDef, 'kind'>, fallback: DefaultDriveMode): ResolvedDrive {
  const d = DRIVE_DEFAULTS[dof.kind];
  const cfg = config ?? defaultDriveConfig(fallback, dof);
  const base: ResolvedDrive = { mode: cfg.mode, ...d, rest: 0 };
  switch (cfg.mode) {
    case 'free':
      return { ...base, friction: nonNeg(cfg.friction, d.friction) };
    case 'spring': {
      const s = SPRING_DEFAULTS[dof.kind];
      return {
        ...base,
        stiffness: nonNeg(cfg.stiffness, s.stiffness),
        damping: nonNeg(cfg.damping, s.damping),
        rest: num(cfg.rest, 0),
        maxForce: Number.MAX_VALUE,
      };
    }
    case 'servo':
      return {
        ...base,
        stiffness: nonNeg(cfg.stiffness, d.stiffness),
        damping: nonNeg(cfg.damping, d.damping),
        maxForce: nonNeg(cfg.maxForce, d.maxForce),
        signal: cfg.signal,
      };
    case 'motor':
      return { ...base, gain: nonNeg(cfg.gain, d.gain), maxForce: nonNeg(cfg.maxForce, d.maxForce), signal: cfg.signal };
    default:
      throw new Error(`Unknown drive mode "${(cfg as { mode: unknown }).mode}"`);
  }
}

export const isDriven = (mode: DriveMode): boolean => mode === 'servo' || mode === 'motor';
