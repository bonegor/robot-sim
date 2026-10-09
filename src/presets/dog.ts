import type { Blueprint, DofSpec } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import { num, walkerBrain } from './walker';

export interface DogOptions {
  /** Steps per second. */
  frequency?: number;
  /** Hip swing amplitude (rad). */
  stride?: number;
  /** Extra knee bend while a foot swings forward (rad). */
  lift?: number;
  /** Hip angle of the standing crouch (rad); the knee bends twice as much the other way. */
  crouch?: number;
}

/**
 * Quadruped that trots off on its own and can be steered (see `walkerBrain`
 * for the keys and the channels it reads).
 *
 * Gait: a trot. Diagonal leg pairs share a phase of the `gait` clock
 * (front-left + hind-right at 0, front-right + hind-left at 0.5).
 *   hip  = posture + stride · sine(gait + phase)          (the foot moves back while the hip angle grows)
 *   knee = −2 · posture − lift · pulse(gait + phase − ¼)   (bend the knee only while the foot swings forward)
 *
 * Steering: a stance foot cannot slip sideways, so legs that only swing
 * fore and aft cannot turn the body. Each paw therefore sits on a gliding
 * "ankle" that shifts it sideways: in stance the front paws sweep one way
 * and the hind paws the other, which twists the body round, helped by
 * longer strides on the outside of the turn. With no key held, the dog
 * keeps the heading it was left on.
 *
 * Balance reflexes read the body sensors: legs on the low side extend
 * (roll, pitch), and all paws step towards a sideways drift.
 */
export function dog(options: DogOptions = {}): Blueprint {
  const f = options.frequency ?? 2;
  const stride = options.stride ?? 0.3;
  const lift = options.lift ?? 0.6;
  const crouch = options.crouch ?? 0.5;

  // Gains picked from the middle of a range that walks, turns and shrugs off
  // pokes for any solver iteration count from 8 to 16 (see tests/scenarios.test.ts).
  const servo = { stiffness: 300, damping: 12, maxForce: 15 };
  const b = new RobotBuilder('Dog', 'Steerable trotting quadruped: servo legs on a shared gait clock, sliding paws to turn, balance reflexes, a springy tail.')
    .root('torso', 'plate', { size: { width: 0.3, thickness: 0.07, length: 0.55 }, density: 400 });
  walkerBrain(b, { frequency: f, stride, turnGain: 0.5, reverse: -0.6, turnPace: 0.5 })
    // Sideways speed of the body, for the stepping reflex of the paws.
    .channel('drift', { kind: 'expression', expr: 'vx * cos(yaw) - vz * sin(yaw)' });

  const legs: [string, string, number, 'l' | 'r', 'front' | 'hind'][] = [
    ['fl', 'bottom_fl', 0, 'l', 'front'],
    ['fr', 'bottom_fr', 0.5, 'r', 'front'],
    ['hl', 'bottom_bl', 0.5, 'l', 'hind'],
    ['hr', 'bottom_br', 0, 'r', 'hind'],
  ];
  for (const [name, corner, phase, side, end] of legs) {
    // Standing crouch, corrected so the legs on the low side extend.
    const posture = `${num(crouch)} ${side === 'l' ? '+' : '-'} roll ${end === 'front' ? '+' : '-'} 0.25 * pitch`;
    const clock = phase ? `gait + ${phase}` : 'gait';
    const hip: Record<string, DofSpec> = {
      bend: { initial: crouch, drive: { mode: 'servo', ...servo, signal: { kind: 'expression', expr: `${posture} + stride_${side} * wave(${clock})` } } },
    };
    const knee: Record<string, DofSpec> = {
      bend: {
        initial: -2 * crouch,
        drive: { mode: 'servo', ...servo, signal: { kind: 'expression', expr: `-2 * (${posture}) - ${num(lift)} * stepping * pulse(gait + ${(phase + 0.75) % 1})` } },
      },
    };
    const ankle: Record<string, DofSpec> = {
      shift_side: {
        limits: [-0.05, 0.05],
        drive: {
          mode: 'servo',
          stiffness: 3000,
          damping: 60,
          maxForce: 80,
          signal: { kind: 'expression', expr: `${end === 'front' ? '-' : ''}0.03 * turn * wave(${clock}) + 0.08 * drift` },
        },
      },
      shift_up: { limits: [0, 0] },
    };
    b.attach(`hip_${name}`, 'hinge', `torso.${corner}`, { id: `thigh_${name}`, type: 'bone', size: { length: 0.19, radius: 0.022 }, density: 600 }, { dofs: hip })
      .attach(`knee_${name}`, 'hinge', `thigh_${name}.bottom`, { id: `shin_${name}`, type: 'bone', size: { length: 0.19, radius: 0.018 }, density: 600 }, { dofs: knee })
      .attach(`ankle_${name}`, 'gliding', `shin_${name}.bottom`, { id: `paw_${name}`, type: 'sphere', size: { radius: 0.026 }, density: 600, color: '#3d405b' }, { dofs: ankle });
  }

  // Passive tail: three springy spine discs, so it bounces along with the gait.
  const tailSpring = (bend: number): Record<string, DofSpec> => ({
    bend: { initial: bend, drive: { mode: 'spring', stiffness: 0.15, damping: 0.003, rest: bend } },
    swing: { drive: { mode: 'spring', stiffness: 0.15, damping: 0.003 } },
    twist: { drive: { mode: 'spring', stiffness: 0.15, damping: 0.003 } },
  });
  b.attach('tail_base', 'spine', 'torso.back', { id: 'tail1', type: 'rod', snap: 'bottom', size: { length: 0.09, radius: 0.012 }, density: 500, color: '#c08552' }, { dofs: tailSpring(-0.4) })
    .attach('tail_mid', 'spine', 'tail1.top', { id: 'tail2', type: 'rod', snap: 'bottom', size: { length: 0.08, radius: 0.01 }, density: 500, color: '#c08552' }, { dofs: tailSpring(0) })
    .attach('tail_tip', 'spine', 'tail2.top', { id: 'tail3', type: 'rod', snap: 'bottom', size: { length: 0.07, radius: 0.008 }, density: 500, color: '#c08552' }, { dofs: tailSpring(0) });

  // Head on a hinge turned a quarter turn so it swings left/right: it looks
  // into turns and glances around. Floppy ears hang on free hinges.
  b.attach('neck', 'hinge', 'torso.front', { id: 'head', type: 'block', snap: 'back', size: { x: 0.12, y: 0.1, z: 0.12 }, density: 250, color: '#d4a373' }, {
    angle: Math.PI / 2,
    dofs: {
      bend: {
        limits: [-0.8, 0.8],
        drive: { mode: 'servo', stiffness: 40, damping: 1, maxForce: 3, signal: { kind: 'expression', expr: 'smooth(0.5 * turn + 0.3 * wave(0.15 * t), 0.3)' } },
      },
    },
  })
    .attach('muzzle', 'weld', 'head.front', { id: 'snout', type: 'block', snap: 'back', size: { x: 0.07, y: 0.06, z: 0.06 }, density: 250, color: '#c9935f' })
    .attach('nose_tip', 'weld', 'snout.front', { id: 'nose', type: 'sphere', snap: 'back', size: { radius: 0.017 }, density: 300, color: '#22223b' });
  for (const [side, face] of [['l', 'left'], ['r', 'right']] as const) {
    b.attach(`ear_${side}_joint`, 'hinge', `head.${face}`, { id: `ear_${side}`, type: 'bone', size: { length: 0.08, radius: 0.016 }, density: 300, color: '#9c6644' }, {
      dofs: { bend: { initial: 1.3, limits: [0.4, 1.6], drive: { mode: 'free', friction: 0.0005 } } },
    });
  }
  return b.build();
}
