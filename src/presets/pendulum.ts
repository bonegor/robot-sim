import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';

/**
 * Nothing but free joints: a chain of limbs hanging from a pinned block.
 * It starts bent and is released, so it tumbles chaotically — the purely
 * passive "freely flapping" case. The top joint is a hinge, the others are
 * ball-and-socket joints, so the motion leaves the plane after a while.
 */
export function pendulum(links = 4): Blueprint {
  const b = new RobotBuilder('Pendulum chain', 'All joints free: a hinge and ball joints released from a bent pose.')
    .root('mount', 'block', { pinned: true, size: { x: 0.12, y: 0.06, z: 0.12 }, color: '#6c757d' })
    .spawn({ position: { x: 0, y: 1.6, z: 0 } })
    .attach('j1', 'hinge', 'mount.bottom', { id: 'link1', type: 'bone', size: { length: 0.3, radius: 0.025 } }, {
      dofs: { bend: { limits: null, initial: 1.2, drive: { mode: 'free', friction: 0.002 } } },
    });
  for (let i = 2; i <= links; i++) {
    b.attach(`j${i}`, 'ball', `link${i - 1}.bottom`, { id: `link${i}`, type: 'bone', size: { length: 0.26 - 0.03 * (i - 2), radius: 0.02 } }, {
      dofs: {
        bend: { limits: null, initial: i === 2 ? -0.9 : 0.5, drive: { mode: 'free', friction: 0.001 } },
        swing: { limits: [-1.5, 1.5], initial: i === 3 ? 0.4 : 0, drive: { mode: 'free', friction: 0.001 } },
        twist: { drive: { mode: 'free', friction: 0.001 } },
      },
    });
  }
  b.attach('weight', 'weld', `link${links}.bottom`, { id: 'bob', type: 'sphere', size: { radius: 0.05 }, color: '#e63946' });
  return b.build();
}
