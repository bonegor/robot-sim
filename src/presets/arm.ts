import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import type { SignalSpec } from '../core/signals';

/**
 * Robot arm bolted to the floor. Keys jog each joint and it stays where you
 * leave it (keyboard signals in "hold" mode):
 *
 *   Q / E  turntable (pivot)        W / S  shoulder (hinge)
 *   A / D  elbow (hinge)            Z / X  wrist (condyloid, two axes: Z/X bend, C/V rock)
 *
 * The two fingers hang on free hinges, so they dangle and swing.
 */
export function arm(): Blueprint {
  const jog = (positive: string, negative: string, rest = 0, speed = 1.2): SignalSpec => ({
    kind: 'keys',
    positive,
    negative,
    amount: speed,
    rest,
    hold: true,
    min: -3,
    max: 3,
  });
  const servo = (signal: SignalSpec, maxForce: number, initial = 0) => ({
    initial,
    drive: { mode: 'servo' as const, stiffness: 400, damping: 12, maxForce, signal },
  });

  return new RobotBuilder('Arm', 'Floor-mounted arm: hold Q/E, W/S, A/D, Z/X, C/V to jog the joints; the fingers swing freely.')
    .root('base', 'cylinder', { pinned: true, size: { length: 0.08, radius: 0.14 }, color: '#495057' })
    .attach('turntable', 'pivot', 'base.top', { id: 'platter', type: 'disc', snap: 'face_bottom', size: { radius: 0.11, thickness: 0.04 } }, {
      dofs: { twist: { limits: [-3, 3], ...servo(jog('q', 'e'), 40) } },
    })
    .attach('shoulder', 'hinge', 'platter.face_top', { id: 'upper_arm', type: 'rod', snap: 'bottom', size: { length: 0.32, radius: 0.025 }, color: '#f4a261' }, {
      dofs: { bend: { limits: [-1.6, 1.6], ...servo(jog('s', 'w', 0.3, 0.9), 60, 0.3) } },
    })
    .attach('elbow', 'hinge', 'upper_arm.top', { id: 'forearm', type: 'rod', snap: 'bottom', size: { length: 0.28, radius: 0.02 }, color: '#e76f51' }, {
      dofs: { bend: { limits: [-2.4, 2.4], ...servo(jog('d', 'a', 1.2, 1.2), 30, 1.2) } },
    })
    .attach('wrist', 'condyloid', 'forearm.top', { id: 'hand', type: 'block', size: { x: 0.08, y: 0.04, z: 0.06 } }, {
      dofs: {
        bend: servo(jog('x', 'z', 0, 1.5), 8),
        swing: servo(jog('v', 'c', 0, 0.8), 8),
      },
    })
    .attach('finger_l', 'hinge', 'hand.top', { id: 'finger1', type: 'bone', size: { length: 0.09, radius: 0.01 } }, {
      dofs: { bend: { limits: [-1.2, 1.2], drive: { mode: 'free', friction: 0.001 } } },
    })
    .attach('finger_r', 'hinge', 'hand.left', { id: 'finger2', type: 'bone', size: { length: 0.07, radius: 0.01 } }, {
      dofs: { bend: { limits: [-1.2, 1.2], drive: { mode: 'free', friction: 0.001 } } },
    })
    .build();
}
