import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import type { DofSpec } from '../core/blueprint';

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
 * Quadruped: a plate torso, four two-segment legs on hinges, a springy tail
 * and a head that looks around.
 *
 * Trot gait from plain wave signals: diagonal leg pairs share a phase
 * (front-left + hind-right at 0, front-right + hind-left at 0.5).
 * hip  = crouch + stride · sine(f·t + phase)          (foot moves back while the hip angle grows)
 * knee = −2·crouch − lift · pulse(f·t + phase − ¼)    (bend the knee only while the foot swings forward)
 */
export function dog(options: DogOptions = {}): Blueprint {
  const f = options.frequency ?? 1.6;
  const stride = options.stride ?? 0.25;
  const lift = options.lift ?? 0.6;
  const crouch = options.crouch ?? 0.5;

  // Gains picked from the middle of a range that walks reliably for any solver
  // iteration count from 8 to 16 (see tests/scenarios.test.ts).
  const servo = { stiffness: 300, damping: 12, maxForce: 15 };
  const hip = (phase: number): Record<string, DofSpec> => ({
    bend: {
      initial: crouch,
      drive: { mode: 'servo', ...servo, signal: { kind: 'wave', shape: 'sine', amplitude: stride, frequency: f, phase, offset: crouch } },
    },
  });
  const knee = (phase: number): Record<string, DofSpec> => ({
    bend: {
      initial: -2 * crouch,
      drive: {
        mode: 'servo',
        ...servo,
        signal: { kind: 'wave', shape: 'pulse', amplitude: -lift, frequency: f, phase: (phase + 0.75) % 1, offset: -2 * crouch },
      },
    },
  });

  const b = new RobotBuilder('Dog', 'Trotting quadruped: servo legs driven by phase-shifted waves, a floppy spring tail and a head that looks around.')
    .root('torso', 'plate', { size: { width: 0.36, thickness: 0.06, length: 0.55 }, density: 400 });

  const legs: [string, string, number][] = [
    ['fl', 'bottom_fl', 0],
    ['fr', 'bottom_fr', 0.5],
    ['hl', 'bottom_bl', 0.5],
    ['hr', 'bottom_br', 0],
  ];
  for (const [name, corner, phase] of legs) {
    b.attach(`hip_${name}`, 'hinge', `torso.${corner}`, { id: `thigh_${name}`, type: 'bone', size: { length: 0.16, radius: 0.02 }, density: 600 }, { dofs: hip(phase) })
      .attach(`knee_${name}`, 'hinge', `thigh_${name}.bottom`, { id: `shin_${name}`, type: 'bone', size: { length: 0.14, radius: 0.018 }, density: 600 }, { dofs: knee(phase) })
      .attach(`ankle_${name}`, 'weld', `shin_${name}.bottom`, { id: `paw_${name}`, type: 'sphere', size: { radius: 0.025 }, density: 600, color: '#3d405b' });
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

  // Head on a hinge turned a quarter turn so it swings left/right ("looking around").
  b.attach('neck', 'hinge', 'torso.front', { id: 'head', type: 'block', snap: 'back', size: { x: 0.12, y: 0.1, z: 0.12 }, density: 250, color: '#d4a373' }, {
    angle: Math.PI / 2,
    dofs: {
      bend: {
        limits: [-0.8, 0.8],
        drive: { mode: 'servo', stiffness: 40, damping: 1, maxForce: 3, signal: { kind: 'wave', shape: 'sine', amplitude: 0.5, frequency: 0.25, phase: 0, offset: 0 } },
      },
    },
  });
  return b.build();
}
