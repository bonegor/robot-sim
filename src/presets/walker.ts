import type { RobotBuilder } from '../core/builder';

/** Keyboard hints shared by the walkers that use `walkerBrain`. */
export const WALKER_CONTROLS = '←/→ or A/D steer · ↓/S back up · Space stop/go · ↑/W walk while stopped';

export interface WalkerBrainOptions {
  /** Gait cycles per second. */
  frequency: number;
  /** Stride (rad of hip swing) at full speed. */
  stride: number;
  /** How much of the stride one side gives up (and the other gains) at full turn. */
  turnGain: number;
  /** Throttle while backing up (negative). */
  reverse: number;
  /** Forward pace kept while turning on the spot, for walkers that cannot pivot in place. */
  turnPace?: number;
  /** For walkers whose root sways or bends as they walk. */
  heading?: {
    /** Expression for the direction the body faces (default the root's `yaw`). */
    yaw?: string;
    /** Seconds over which that direction is averaged before it is held. */
    smoothing?: number;
    /**
     * Seconds the held heading keeps following the body after a turn key is
     * released, for walkers that take a while to come out of a turn.
     */
    settle?: number;
  };
}

/** A number as short expression text. */
export const num = (x: number): string => Number(x.toFixed(4)).toString();

/**
 * The brain shared by the legged walkers: channels that turn the keyboard
 * into a gait clock (`gait`, in cycles), a stride for each side
 * (`stride_l`, `stride_r`), a turn command (`turn`, −1…1) and how much the
 * legs step at all (`stepping`, 0…1).
 *
 * The walker sets off on its own. Holding ←/→ (A/D) steers; with no key
 * held it keeps the heading it was left on (`heading` remembers the yaw).
 * ↓/S backs up, Space stops and restarts it, ↑/W walks while stopped.
 */
export function walkerBrain(b: RobotBuilder, o: WalkerBrainOptions): RobotBuilder {
  const h = o.heading ?? {};
  let yaw = h.yaw ? `(${h.yaw})` : 'yaw';
  if (h.smoothing) {
    // Averaging sine and cosine keeps the mean heading right across ±π.
    const tau = num(h.smoothing);
    b.channel('course', { kind: 'expression', expr: `atan2(smooth(sin(${yaw}), ${tau}), smooth(cos(${yaw}), ${tau}))` });
    yaw = 'course';
  }
  // A smoothed key press fades out over about `settle` seconds after release.
  const following = h.settle ? `smooth(steer != 0, ${num(h.settle / 3)}) > 0.05` : 'steer != 0';
  b.channel('steer', { kind: 'expression', expr: 'clamp(axis("a", "d") + axis("left", "right"), -1, 1)' })
    .channel('heading', { kind: 'expression', expr: `hold(${yaw}, ${following})` })
    .channel('turn', { kind: 'expression', expr: `smooth(steer != 0 ? steer : clamp(1.5 * atan2(sin(heading - ${yaw}), cos(heading - ${yaw})), -1, 1), 0.2)` })
    .channel('go', { kind: 'expression', expr: '1 - toggle("space")' })
    // Eases in over the first second, so the walker does not lurch off.
    .channel('throttle', { kind: 'expression', expr: `smooth(min(1, t) * (key("s") || key("down") ? ${num(o.reverse)} : go || key("w") || key("up") ? 1 : 0), 0.4)` });
  const pace = o.turnPace ? 'pace' : 'throttle';
  if (o.turnPace) b.channel('pace', { kind: 'expression', expr: `throttle + ${num(o.turnPace)} * abs(turn) * (1 - abs(throttle))` });
  return b
    .channel('stepping', { kind: 'expression', expr: `smooth(min(1, 3 * max(abs(${pace}), abs(turn))), 0.2)` })
    .channel('stride_l', { kind: 'expression', expr: `${num(o.stride)} * clamp(${pace} - ${num(o.turnGain)} * turn, -1, 1)` })
    .channel('stride_r', { kind: 'expression', expr: `${num(o.stride)} * clamp(${pace} + ${num(o.turnGain)} * turn, -1, 1)` })
    .channel('gait', { kind: 'expression', expr: `integrate(${num(o.frequency)})` });
}
