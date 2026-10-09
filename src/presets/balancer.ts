import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';

/**
 * Two-wheeled self-balancing robot: an inverted pendulum that stays up only
 * because its wheels keep driving under it. The whole controller is a chain
 * of logic channels reading the `pitch` and `forward` sensors:
 *
 *   lean   = −pitch                          how far it leans forward (rad)
 *   cruise = speed asked for with ↑/↓ (m/s)
 *   aim    = lean that gets it to that speed: leaning forward is how it
 *            accelerates; the integral part stops it creeping away
 *   error  = lean − aim
 *   drive  = 300 · ∫error + 60 · error        wheel speed (rad/s): run the
 *            wheels under the lean to catch it
 *
 * The wheels are speed motors following `drive` (minus / plus `steer` to
 * turn). Two arms hang on free hinges and swing as it brakes and speeds up.
 * Poke it: it catches itself.
 */
export function balancer(): Blueprint {
  const wheel = { type: 'wheel' as const, size: { radius: 0.12, thickness: 0.05 } };
  const motor = (expr: string) => ({ spin: { drive: { mode: 'motor' as const, gain: 20, maxForce: 15, signal: { kind: 'expression' as const, expr } } } });
  const b = new RobotBuilder('Balancer', 'Two-wheeled inverted pendulum that balances itself with a feedback loop on its pitch sensor.')
    .root('chassis', 'block', { size: { x: 0.26, y: 0.08, z: 0.08 }, density: 500, color: '#495057' })
    .channel('lean', { kind: 'expression', expr: '-pitch' })
    .channel('cruise', { kind: 'expression', expr: 'smooth(0.6 * clamp(axis("up", "down") + axis("w", "s"), -1, 1), 0.6)' })
    .channel('aim', { kind: 'expression', expr: 'clamp(0.15 * (cruise - forward) + 0.1 * integrate(cruise - forward, -1, 1), -0.15, 0.15)' })
    .channel('error', { kind: 'expression', expr: 'lean - aim' })
    .channel('drive', { kind: 'expression', expr: '300 * integrate(error, -0.6, 0.6) + 60 * error' })
    .channel('steer', { kind: 'expression', expr: 'smooth(1.2 * clamp(axis("left", "right") + axis("a", "d"), -1, 1), 0.3)' })
    // Wheels on the left spin about +X, on the right about −X (see the rover).
    .attach('axle_l', 'wheel', 'chassis.left', { id: 'wheel_l', ...wheel }, { dofs: motor('drive - steer') })
    .attach('axle_r', 'wheel', 'chassis.right', { id: 'wheel_r', ...wheel }, { dofs: motor('-(drive + steer)') })
    .attach('waist', 'weld', 'chassis.top', { id: 'body', type: 'block', size: { x: 0.11, y: 0.2, z: 0.07 }, density: 400, color: '#e9c46a' })
    .attach('collar', 'weld', 'body.top', { id: 'shoulders', type: 'plate', size: { width: 0.46, thickness: 0.03, length: 0.08 }, density: 250, color: '#2a9d8f' })
    .attach('neck', 'weld', 'shoulders.top', { id: 'head', type: 'sphere', size: { radius: 0.06 }, density: 800, color: '#264653' })
    .attach('face', 'weld', 'head.front', { id: 'visor', type: 'block', snap: 'back', size: { x: 0.07, y: 0.025, z: 0.015 }, density: 300, color: '#90e0ef' });
  for (const [side, corner] of [['l', 'bottom_fl'], ['r', 'bottom_fr']] as const) {
    b.attach(`shoulder_${side}`, 'hinge', `shoulders.${corner}`, { id: `arm_${side}`, type: 'bone', size: { length: 0.15, radius: 0.016 }, density: 500, color: '#2a9d8f' }, {
      dofs: { bend: { drive: { mode: 'free', friction: 0.002 } } },
    });
  }
  return b.build();
}
