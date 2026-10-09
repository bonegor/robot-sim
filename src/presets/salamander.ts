import type { Blueprint, DofSpec } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import { num, walkerBrain } from './walker';

export interface SalamanderOptions {
  /** Steps per second. */
  frequency?: number;
  /** Bend of each spine joint in the body wave (rad); 0 walks on the legs alone. */
  wave?: number;
  /** Timing of the body wave against the legs, in cycles (0.5 helps the stride most). */
  wavePhase?: number;
}

/**
 * Sprawling quadruped in the colours of a fire salamander: its legs stick
 * out sideways like a lizard's, and its spine and tail swing in a wave
 * locked to the steps.
 *
 * Body: a chain of segments like the snake's. The first hinge is turned a
 * quarter turn, so every spine hinge bends left/right; on those turned
 * segments a plain hinge at a side snap swings a leg fore and aft.
 * Front legs hang off the shoulder girdle, hind legs off the hips.
 *
 * Gait: a walking trot (diagonal legs together) plus a standing wave of
 * the trunk. Bent at the right moment, the trunk swings each shoulder and
 * hip forward with the leg that is reaching, which lengthens the stride:
 * with `wavePhase` 0.5 it walks about 40% faster than on its legs alone,
 * while the opposite timing stalls it. The tail carries the wave on
 * as a travelling wave, and the neck turns against it so the head looks
 * where it is going. It steers with unequal strides and a bend in its spine.
 */
export function salamander(options: SalamanderOptions = {}): Blueprint {
  const f = options.frequency ?? 1.4;
  const wave = options.wave ?? 0.35;
  const wavePhase = options.wavePhase ?? 0.5;
  const stride = 0.4;
  const lift = 0.5;
  const droop = 1;

  const servo = { stiffness: 150, damping: 5, maxForce: 8 };
  const spineServo = { stiffness: 150, damping: 6, maxForce: 10 };
  const black = '#26262b';
  const yellow = '#f4c430';
  const segment = (id: string, length: number, radius: number, color: string) => ({ id, type: 'cylinder' as const, snap: 'top', size: { length, radius }, density: 600, color });
  /** A spine joint following the body wave, `lag` cycles behind the trunk. */
  const bend = (amplitude: number, lag: number, steer: boolean): Record<string, DofSpec> => ({
    bend: {
      limits: [-0.8, 0.8],
      drive: {
        mode: 'servo',
        ...spineServo,
        signal: { kind: 'expression', expr: `${num(amplitude)} * throttle * wave(gait + ${num(wavePhase + lag)})${steer ? ' + 0.3 * turn' : ''}` },
      },
    },
  });

  const b = new RobotBuilder('Salamander', 'Sprawling quadruped whose spine and tail wave in step with its legs; steerable.')
    .root('head', 'block', { size: { x: 0.1, y: 0.05, z: 0.11 }, density: 600, color: black });
  // Steering bends the spine, which swings the head (the root) against the
  // turn, so the heading to hold is the trunk's: the head's yaw plus the
  // bends in between. The body takes about a second to come out of a turn.
  walkerBrain(b, {
    frequency: f,
    stride,
    turnGain: 1,
    reverse: -0.6,
    heading: { yaw: 'yaw + angle("neck") + angle("spine1")', smoothing: 0.25, settle: 1 },
  });
  for (const face of ['left', 'right'] as const) {
    b.attach(`eye_${face}`, 'weld', `head.${face}`, { id: `eyeball_${face}`, type: 'sphere', size: { radius: 0.014 }, density: 300, color: '#111111' });
  }
  b.attach('neck', 'hinge', 'head.back', segment('shoulders', 0.12, 0.045, yellow), {
    angle: Math.PI / 2,
    // Turns against the body wave, keeping the head steady.
    dofs: { bend: { limits: [-0.8, 0.8], drive: { mode: 'servo', ...spineServo, signal: { kind: 'expression', expr: `${num(-1.5 * wave)} * throttle * wave(gait + ${num(wavePhase)})` } } } },
  })
    .attach('spine1', 'hinge', 'shoulders.bottom', segment('trunk', 0.12, 0.045, black), { dofs: bend(wave, 0, true) })
    .attach('spine2', 'hinge', 'trunk.bottom', segment('hips', 0.12, 0.045, yellow), { dofs: bend(wave, 0, true) })
    .attach('tail1', 'hinge', 'hips.bottom', segment('tail_base', 0.1, 0.035, black), { dofs: bend(0.3, 0.15, false) })
    .attach('tail2', 'hinge', 'tail_base.bottom', segment('tail_mid', 0.09, 0.025, yellow), { dofs: bend(0.3, 0.3, false) })
    .attach('tail3', 'hinge', 'tail_mid.bottom', { id: 'tail_tip', type: 'bone', snap: 'top', size: { length: 0.1, radius: 0.015 }, density: 600, color: black }, { dofs: bend(0.3, 0.45, false) });

  // Left legs on the segments' mid_front snaps, right legs on mid_back (the
  // segments are turned on their side). Positive hip angles move a foot back
  // on both sides.
  const legs: [string, string, number][] = [
    ['fl', 'shoulders.mid_front', 0],
    ['fr', 'shoulders.mid_back', 0.5],
    ['hl', 'hips.mid_front', 0.5],
    ['hr', 'hips.mid_back', 0],
  ];
  for (const [name, mount, phase] of legs) {
    const side = name[1] as 'l' | 'r';
    const rest = name[0] === 'f' ? -0.2 : 0.2; // front feet reach forward, hind feet trail
    const clock = phase ? `gait + ${phase}` : 'gait';
    b.attach(`hip_${name}`, 'hinge', mount, { id: `femur_${name}`, type: 'bone', size: { length: 0.09, radius: 0.015 }, density: 700, color: black }, {
      dofs: { bend: { initial: rest, limits: [-1.3, 1.3], drive: { mode: 'servo', ...servo, signal: { kind: 'expression', expr: `${num(rest)} + stride_${side} * wave(${clock})` } } } },
    }).attach(`knee_${name}`, 'hinge', `femur_${name}.bottom`, { id: `shin_${name}`, type: 'bone', size: { length: 0.12, radius: 0.013 }, density: 700, color: yellow }, {
      angle: side === 'l' ? -Math.PI / 2 : Math.PI / 2,
      dofs: {
        bend: {
          initial: droop,
          drive: { mode: 'servo', ...servo, signal: { kind: 'expression', expr: `${droop} - ${num(lift)} * stepping * pulse(gait + ${(phase + 0.75) % 1})` } },
        },
      },
    });
  }
  return b.build();
}
