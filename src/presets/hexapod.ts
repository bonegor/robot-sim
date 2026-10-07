import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import type { DofSpec } from '../core/blueprint';

/**
 * Six-legged walker with a tripod gait. Each hip is a saddle joint with two
 * driven axes: `swing` moves the leg forward/back, `bend` lifts it. Three
 * legs (front-left, middle-right, back-left) step together, then the other three.
 *
 * Hips on the left spin about +Y with positive swing moving the foot back;
 * on the right the same rotation moves the foot forward, so the right-hand
 * stride signal is negated.
 */
export function hexapod(frequency = 1.2): Blueprint {
  const stride = 0.3;
  const lift = 0.35;
  const servo = { stiffness: 300, damping: 6, maxForce: 12 };
  const hip = (side: 1 | -1, phase: number): Record<string, DofSpec> => ({
    swing: {
      drive: { mode: 'servo', ...servo, signal: { kind: 'wave', shape: 'sine', amplitude: side * stride, frequency, phase, offset: 0 } },
    },
    bend: {
      drive: { mode: 'servo', ...servo, signal: { kind: 'wave', shape: 'pulse', amplitude: -lift, frequency, phase: (phase + 0.75) % 1, offset: 0 } },
    },
  });
  const knee: Record<string, DofSpec> = {
    bend: { initial: Math.PI / 2, drive: { mode: 'servo', ...servo, signal: { kind: 'constant', value: Math.PI / 2 } } },
  };

  const b = new RobotBuilder('Hexapod', 'Tripod gait: every hip is a two-axis saddle joint driven by two waves.')
    .root('body', 'plate', { size: { width: 0.24, thickness: 0.05, length: 0.48 }, color: '#457b9d' });
  const legs: [string, string, 1 | -1, number][] = [
    ['lf', 'left_front', 1, 0],
    ['lm', 'left', 1, 0.5],
    ['lb', 'left_back', 1, 0],
    ['rf', 'right_front', -1, 0.5],
    ['rm', 'right', -1, 0],
    ['rb', 'right_back', -1, 0.5],
  ];
  for (const [name, snap, side, phase] of legs) {
    b.attach(`hip_${name}`, 'saddle', `body.${snap}`, { id: `femur_${name}`, type: 'bone', size: { length: 0.11, radius: 0.016 }, density: 2500 }, { dofs: hip(side, phase) })
      .attach(`knee_${name}`, 'hinge', `femur_${name}.bottom`, { id: `tibia_${name}`, type: 'bone', size: { length: 0.17, radius: 0.014 }, density: 2500, color: '#1d3557' }, { dofs: knee });
  }
  return b.build();
}
