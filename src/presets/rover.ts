import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';

/**
 * Four-wheel skid-steer rover driven from the keyboard (arrows or WASD),
 * with a springy antenna that wobbles as it drives.
 *
 * The brain has two channels, `throttle` and `steer`, built from the keys and
 * smoothed a little. Every wheel axle runs a speed motor mixing the two.
 * Wheels on the left spin about +X, wheels on the right about −X, which is why
 * the right-hand mix is negated.
 */
export function rover(): Blueprint {
  const wheel = { type: 'wheel' as const, size: { radius: 0.1, thickness: 0.05 } };
  const motor = (expr: string) => ({ spin: { drive: { mode: 'motor' as const, gain: 6, maxForce: 6, signal: { kind: 'expression' as const, expr } } } });
  const left = '12 * throttle - 7 * steer';
  const right = '-(12 * throttle + 7 * steer)';
  const antenna = (stiffness: number) => ({
    bend: { drive: { mode: 'spring' as const, stiffness, damping: stiffness * 0.01 } },
    swing: { drive: { mode: 'spring' as const, stiffness, damping: stiffness * 0.01 } },
    twist: { drive: { mode: 'spring' as const, stiffness: 1, damping: 0.02 } },
  });

  return new RobotBuilder('Rover', 'Skid-steer rover: arrow keys / WASD drive the wheel motors, the antenna is a passive spring.')
    .root('chassis', 'plate', { size: { width: 0.3, thickness: 0.06, length: 0.5 }, density: 450 })
    .channel('throttle', { kind: 'expression', expr: 'smooth(clamp(axis("up", "down") + axis("w", "s"), -1, 1), 0.25)' })
    .channel('steer', { kind: 'expression', expr: 'smooth(clamp(axis("left", "right") + axis("a", "d"), -1, 1), 0.15)' })
    .attach('axle_lf', 'wheel', 'chassis.left_front', { id: 'wheel_lf', ...wheel }, { dofs: motor(left) })
    .attach('axle_lb', 'wheel', 'chassis.left_back', { id: 'wheel_lb', ...wheel }, { dofs: motor(left) })
    .attach('axle_rf', 'wheel', 'chassis.right_front', { id: 'wheel_rf', ...wheel }, { dofs: motor(right) })
    .attach('axle_rb', 'wheel', 'chassis.right_back', { id: 'wheel_rb', ...wheel }, { dofs: motor(right) })
    .attach('mast', 'spine', 'chassis.top_bl', { id: 'antenna1', type: 'rod', snap: 'bottom', size: { length: 0.18, radius: 0.006 }, color: '#9aa0a6' }, { dofs: antenna(0.6) })
    .attach('mast2', 'spine', 'antenna1.top', { id: 'antenna2', type: 'rod', snap: 'bottom', size: { length: 0.16, radius: 0.005 }, color: '#9aa0a6' }, { dofs: antenna(0.25) })
    .attach('tip', 'weld', 'antenna2.top', { id: 'antenna_ball', type: 'sphere', size: { radius: 0.018 }, color: '#e63946' })
    .build();
}
