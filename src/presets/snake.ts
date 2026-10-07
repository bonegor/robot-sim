import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';

/**
 * Wheeled snake: a chain of segments whose joints follow one travelling
 * sine wave (each joint lags the previous one), while the little side wheels
 * spin freely. The wheels roll easily forwards but resist sliding sideways,
 * which is what turns the side-to-side wave into forward motion — like the
 * scales on a real snake's belly.
 *
 * The first hinge is turned a quarter turn (`angle`) so it bends left/right.
 * That turn carries down the chain (each segment is snapped onto a turned
 * one), so the remaining hinges need no extra angle — and each segment's
 * sides are its `mid_front` / `mid_back` snaps, where the wheels go.
 */
export function snake(segments = 7): Blueprint {
  const wheelSize = { radius: 0.045, thickness: 0.015 };
  const freeWheel = { spin: { drive: { mode: 'free' as const, friction: 0.002 } } };
  const b = new RobotBuilder('Snake', 'Lateral undulation: a travelling wave of servo hinges plus free-spinning wheels for grip.')
    .root('head', 'block', { size: { x: 0.08, y: 0.06, z: 0.1 }, color: '#2a9d8f' })
    .attach('head_wl', 'wheel', 'head.left', { id: 'head_wheel_l', type: 'wheel', size: wheelSize }, { dofs: freeWheel })
    .attach('head_wr', 'wheel', 'head.right', { id: 'head_wheel_r', type: 'wheel', size: wheelSize }, { dofs: freeWheel });

  let prev = 'head.back';
  for (let i = 1; i <= segments; i++) {
    const seg = `seg${i}`;
    b.attach(`spine${i}`, 'hinge', prev, { id: seg, type: 'cylinder', snap: 'top', size: { length: 0.12, radius: 0.03 }, color: i % 2 ? '#e9c46a' : '#2a9d8f' }, {
      angle: i === 1 ? Math.PI / 2 : 0,
      dofs: {
        bend: {
          limits: [-1, 1],
          drive: {
            mode: 'servo',
            stiffness: 60,
            damping: 1.5,
            maxForce: 6,
            signal: { kind: 'wave', shape: 'sine', amplitude: 0.6, frequency: 0.8, phase: -0.13 * i, offset: 0 },
          },
        },
      },
    });
    b.attach(`axle${i}l`, 'wheel', `${seg}.mid_front`, { id: `${seg}_wl`, type: 'wheel', size: wheelSize }, { dofs: freeWheel });
    b.attach(`axle${i}r`, 'wheel', `${seg}.mid_back`, { id: `${seg}_wr`, type: 'wheel', size: wheelSize }, { dofs: freeWheel });
    prev = `${seg}.bottom`;
  }
  return b.build();
}
