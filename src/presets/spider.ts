import type { Blueprint, DofSpec } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import { walkerBrain } from './walker';

export interface SpiderOptions {
  /** Steps per second. */
  frequency?: number;
  /** Hip swing amplitude (rad). */
  stride?: number;
  /** How far the knees straighten to lift a foot (rad). */
  lift?: number;
}

const num = (x: number): string => Number(x.toFixed(4)).toString();

/**
 * Arachnid: a cephalothorax (prosoma) carrying eight legs, a big abdomen
 * bobbing on a springy waist, twitching fangs and a red stripe.
 *
 * Every leg has two hinges. The hip hinge is turned a quarter turn so it
 * swings the leg fore and aft about the vertical; the knee hinge is turned
 * back so it bends down, holding the body up between the feet. The legs
 * fan out like a real spider's: the front pairs reach forward, the back
 * pairs backward.
 *
 * Gait: alternating tetrapod, as spiders walk. Legs L1 R2 L3 R4 step
 * together, then R1 L2 R3 L4, so one group of four is always pushing.
 *   hip  = fan ± stride · sine(gait + phase)        (the foot moves back while it is down; mirrored on the right)
 *   knee = droop − lift · pulse(gait + phase − ¼)   (the knee straightens to lift the foot as it swings forward)
 * Turning: the legs on one side stride shorter (or backwards) than the
 * other side's, so the spider can spin on the spot.
 */
export function spider(options: SpiderOptions = {}): Blueprint {
  const f = options.frequency ?? 1.6;
  const stride = options.stride ?? 0.35;
  const lift = options.lift ?? 0.5;
  const droop = 1;
  /** How far each pair of legs points forward (rad), front to back. */
  const fan = [0.8, 0.3, -0.3, -0.8];

  const servo = { stiffness: 150, damping: 5, maxForce: 8 };
  const dark = '#24232a';
  const red = '#d62828';
  const b = new RobotBuilder('Spider', 'Eight-legged arachnid walking an alternating tetrapod gait; steerable, with a bobbing abdomen and twitching fangs.')
    .root('prosoma', 'plate', { size: { width: 0.16, thickness: 0.05, length: 0.2 }, density: 600, color: dark })
    .attach('neck', 'weld', 'prosoma.front', { id: 'head', type: 'block', snap: 'back', size: { x: 0.128, y: 0.045, z: 0.065 }, density: 600, color: '#2e2c35' })
    .attach('waist', 'hinge', 'prosoma.back', { id: 'abdomen', type: 'sphere', snap: 'front', size: { radius: 0.09 }, density: 250, color: '#18171c' }, {
      dofs: { bend: { initial: -0.2, limits: [-0.6, 0.4], drive: { mode: 'spring', stiffness: 3, damping: 0.08, rest: -0.2 } } },
    })
    // A stripe along the top of the abdomen, like a redback's: a limb lying on its side.
    .attach('mark', 'weld', 'abdomen.top', { id: 'stripe', type: 'bone', snap: 'mid_front', size: { length: 0.11, radius: 0.013 }, density: 300, color: red })
    .attach('brow', 'weld', 'head.top', { id: 'eyes', type: 'block', size: { x: 0.06, y: 0.016, z: 0.016 }, density: 500, color: dark })
    .attach('mouth', 'weld', 'head.front', { id: 'jaws', type: 'block', snap: 'back', size: { x: 0.07, y: 0.035, z: 0.03 }, density: 500, color: '#2e2c35' });
  for (const [side, face] of [['l', 'left'], ['r', 'right']] as const) {
    b.attach(`eye_${side}_joint`, 'weld', `eyes.${face}`, { id: `eye_${side}`, type: 'sphere', size: { radius: 0.011 }, density: 300, color: red });
    // Fangs on soft servos, twitching in a slow pulse.
    b.attach(`fang_${side}_joint`, 'hinge', `jaws.${face}`, { id: `fang_${side}`, type: 'bone', size: { length: 0.06, radius: 0.009 }, density: 600, color: '#8d1b1b' }, {
      dofs: {
        bend: {
          initial: 1.3,
          limits: [0.6, 1.6],
          drive: { mode: 'servo', stiffness: 2, damping: 0.05, maxForce: 0.5, signal: { kind: 'wave', shape: 'pulse', amplitude: -0.5, frequency: 0.7, phase: side === 'l' ? 0 : 0.08, offset: 1.3 } },
        },
      },
    });
  }
  walkerBrain(b, { frequency: f, stride, turnGain: 1, reverse: -0.7 });

  // Leg mounts front to back: the head's sides, then the three side mounts of the prosoma.
  const mounts: [string, string][] = [
    ['head.left', 'head.right'],
    ['prosoma.left_front', 'prosoma.right_front'],
    ['prosoma.left', 'prosoma.right'],
    ['prosoma.left_back', 'prosoma.right_back'],
  ];
  mounts.forEach(([left, right], i) => {
    for (const side of ['l', 'r'] as const) {
      const name = `${side}${i + 1}`;
      const phase = (i % 2 === 0) === (side === 'l') ? 0 : 0.5;
      // Turned hips swing the same way on both sides; the right side mirrors the left.
      const sign = side === 'l' ? 1 : -1;
      const rest = -sign * fan[i]!;
      const clock = phase ? `gait + ${phase}` : 'gait';
      const hip: Record<string, DofSpec> = {
        bend: {
          initial: rest,
          limits: [-1.4, 1.4],
          drive: { mode: 'servo', ...servo, signal: { kind: 'expression', expr: `${num(rest)} ${sign > 0 ? '+' : '-'} stride_${side} * wave(${clock})` } },
        },
      };
      const knee: Record<string, DofSpec> = {
        bend: {
          initial: droop,
          drive: { mode: 'servo', ...servo, signal: { kind: 'expression', expr: `${droop} - ${num(lift)} * stepping * pulse(gait + ${(phase + 0.75) % 1})` } },
        },
      };
      b.attach(`hip_${name}`, 'hinge', side === 'l' ? left : right, { id: `femur_${name}`, type: 'bone', size: { length: 0.15, radius: 0.013 }, density: 700, color: dark }, {
        angle: Math.PI / 2,
        dofs: hip,
      }).attach(`knee_${name}`, 'hinge', `femur_${name}.bottom`, { id: `tibia_${name}`, type: 'bone', size: { length: 0.28, radius: 0.01 }, density: 700, color: '#3a3842' }, {
        angle: -Math.PI / 2,
        dofs: knee,
      });
    }
  });
  return b.build();
}
