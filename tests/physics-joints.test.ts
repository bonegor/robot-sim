/**
 * Physical behaviour of every joint type and drive mode, simulated in Rapier.
 *
 * The common rig: a block bolted in mid-air with one part hanging off it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Blueprint, DofSpec } from '../src/core/blueprint';
import { RobotBuilder } from '../src/core/builder';
import type { SignalSpec } from '../src/core/signals';
import { JOINT_TYPE_LIST, type JointType } from '../src/core/joints';
import { PART_TYPE_LIST, shapeVolume } from '../src/core/parts';
import { type Robot, Simulation } from '../src/physics/simulation';

let sim: Simulation | null = null;
afterEach(() => {
  sim?.dispose();
  sim = null;
});

async function rig(joint: JointType, dofs: Record<string, DofSpec> = {}, opts: { snap?: string; childSnap?: string; length?: number; density?: number } = {}): Promise<Robot> {
  const bp: Blueprint = new RobotBuilder('rig')
    .root('base', 'block', { pinned: true })
    .attach('j', joint, `base.${opts.snap ?? 'bottom'}`, {
      id: 'arm',
      type: 'rod',
      size: { length: opts.length ?? 0.3 },
      ...(opts.density ? { density: opts.density } : {}),
      ...(opts.childSnap ? { snap: opts.childSnap } : {}),
    }, { dofs })
    .spawn({ position: { x: 0, y: 1, z: 0 } })
    .build();
  sim = await Simulation.create();
  return sim.addRobot(bp);
}

/** Runs `seconds` of simulation, tracking the worst connection error. */
function run(robot: Robot, seconds: number, each?: () => void): { gap: number; angle: number } {
  let gap = 0;
  let angle = 0;
  const steps = Math.round(seconds / robot.sim.timestep);
  for (let i = 0; i < steps; i++) {
    robot.sim.step();
    const w = robot.worstConnection();
    gap = Math.max(gap, w.gap);
    angle = Math.max(angle, w.angle);
    each?.();
  }
  return { gap, angle };
}

const servo = (signal: SignalSpec, extra: Record<string, number> = {}): DofSpec => ({ drive: { mode: 'servo', signal, ...extra } });
const constant = (value: number): SignalSpec => ({ kind: 'constant', value });

describe('every joint type stays connected', () => {
  for (const def of JOINT_TYPE_LIST) {
    it(`${def.label}: parts stay snapped together while being thrown around`, async () => {
      const robot = await rig(def.type, Object.fromEntries(def.dofs.map((d) => [d.name, { initial: d.kind === 'angular' ? 0.5 : 0.01 }])));
      robot.applyImpulse('arm', { x: 0.06, y: 0, z: 0.1 }, { x: 0.01, y: 0.75, z: 0 });
      const ranges = def.dofs.map(() => ({ lo: Infinity, hi: -Infinity }));
      const err = run(robot, 3, () =>
        def.dofs.forEach((d, i) => {
          const p = robot.jointPosition('j', d.name);
          ranges[i]!.lo = Math.min(ranges[i]!.lo, p);
          ranges[i]!.hi = Math.max(ranges[i]!.hi, p);
        }),
      );
      // Locked directions stay locked: sub-millimetre and sub-degree.
      expect(err.gap).toBeLessThan(1e-3);
      expect(err.angle).toBeLessThan(0.01);
      // And the free directions stay inside their limits.
      def.dofs.forEach((d, i) => {
        if (!d.limits) return;
        expect(ranges[i]!.lo, `${d.name} min`).toBeGreaterThanOrEqual(d.limits[0] - 0.02);
        expect(ranges[i]!.hi, `${d.name} max`).toBeLessThanOrEqual(d.limits[1] + 0.02);
      });
    });
  }

  it('a weld keeps the parts rigidly together', async () => {
    const robot = await rig('weld', {}, { snap: 'front', childSnap: 'bottom' });
    const before = robot.partPose('arm');
    const err = run(robot, 2);
    const after = robot.partPose('arm');
    expect(err.gap).toBeLessThan(1e-3);
    expect(Math.hypot(after.p.x - before.p.x, after.p.y - before.p.y, after.p.z - before.p.z)).toBeLessThan(2e-3);
  });

  it('a hinge only rotates about its own axis', async () => {
    const robot = await rig('hinge', { bend: { initial: 1, limits: null } });
    // A sideways shove would twist it if the other axes were not locked.
    robot.applyImpulse('arm', { x: 0.2, y: 0, z: 0.2 }, { x: 0, y: 0.7, z: 0.01 });
    const err = run(robot, 2);
    expect(err.angle).toBeLessThan(0.01);
    expect(err.gap).toBeLessThan(1e-3);
  });
});

describe('free joints flap', () => {
  it('a free hinge swings like a pendulum through the bottom and out the other side', async () => {
    const robot = await rig('hinge', { bend: { initial: 1, limits: null, drive: { mode: 'free', friction: 0 } } });
    let min = Infinity;
    run(robot, 1.5, () => (min = Math.min(min, robot.jointPosition('j'))));
    expect(min).toBeLessThan(-0.8); // released at +1 rad, swings to about −1 rad
  });

  it('joint friction slowly damps a free swing', async () => {
    const swing = async (friction: number) => {
      const robot = await rig('hinge', { bend: { initial: 1, limits: null, drive: { mode: 'free', friction } } });
      let late = 0;
      run(robot, 6, () => {
        if (robot.sim.time > 5) late = Math.max(late, Math.abs(robot.jointPosition('j')));
      });
      sim!.dispose();
      sim = null;
      return late;
    };
    const slippery = await swing(0);
    const sticky = await swing(0.05);
    expect(slippery).toBeGreaterThan(0.8);
    expect(sticky).toBeLessThan(slippery * 0.5);
  });

  it('a free ball joint lets the part move in all three rotational directions', async () => {
    const free = { mode: 'free' as const, friction: 0 };
    const robot = await rig('ball', { bend: { initial: 0.6, drive: free }, swing: { initial: 0.4, drive: free }, twist: { drive: free } });
    robot.parts.get('arm')!.body.setAngvel({ x: 0, y: 3, z: 0 }, true);
    const seen = { bend: new Set<number>(), swing: new Set<number>(), twist: new Set<number>() };
    run(robot, 2, () => {
      for (const k of ['bend', 'swing', 'twist'] as const) seen[k].add(Math.round(robot.jointPosition('j', k) * 20));
    });
    for (const k of ['bend', 'swing', 'twist'] as const) expect(seen[k].size, k).toBeGreaterThan(3);
  });

  it('a free slider drops to its limit under gravity', async () => {
    const robot = await rig('slider', { slide: { limits: [0, 0.12], drive: { mode: 'free' } } });
    run(robot, 1.5);
    expect(robot.jointPosition('j')).toBeCloseTo(0.12, 2);
  });

  it('a free axle keeps spinning', async () => {
    const robot = await rig('wheel', { spin: { drive: { mode: 'free', friction: 0 } } });
    robot.parts.get('arm')!.body.setAngvel({ x: 0, y: -8, z: 0 }, true);
    run(robot, 1);
    expect(Math.abs(robot.jointVelocity('j'))).toBeGreaterThan(7);
    expect(Math.abs(robot.jointPosition('j'))).toBeGreaterThan(2 * Math.PI); // unwrapped past a full turn
  });
});

describe('springs are passive but elastic', () => {
  it('a spring hinge returns to its rest angle', async () => {
    const robot = await rig('hinge', { bend: { initial: 0.8, drive: { mode: 'spring', stiffness: 30, damping: 0.5, rest: -0.2 } } }, { snap: 'front', childSnap: 'bottom' });
    run(robot, 3);
    // Gravity sags it a little below the rest angle (positive bend is downward here).
    const sag = robot.jointPosition('j') - -0.2;
    expect(sag).toBeGreaterThan(0);
    expect(sag).toBeLessThan(0.05);
  });

  it('a stiffer spring sags less', async () => {
    const sagFor = async (stiffness: number) => {
      const robot = await rig('hinge', { bend: { drive: { mode: 'spring', stiffness, damping: 0.5 } } }, { snap: 'front', childSnap: 'bottom' });
      run(robot, 3);
      const sag = robot.jointPosition('j');
      sim!.dispose();
      sim = null;
      return sag;
    };
    const soft = await sagFor(2);
    const stiff = await sagFor(40);
    expect(soft).toBeGreaterThan(stiff * 5);
  });
});

describe('driven joints follow their signals', () => {
  it('a servo holds a constant target against gravity', async () => {
    const robot = await rig('hinge', { bend: servo(constant(0.8)) });
    run(robot, 2);
    expect(robot.jointPosition('j')).toBeCloseTo(0.8, 2);
  });

  it('a servo tracks a moving wave closely', async () => {
    const robot = await rig('hinge', { bend: servo({ kind: 'wave', shape: 'sine', amplitude: 0.6, frequency: 1, phase: 0, offset: 0.2 }) });
    let worst = 0;
    run(robot, 3, () => {
      if (robot.sim.time < 1) return;
      const target = robot.brain.targets().get('j.bend')!;
      worst = Math.max(worst, Math.abs(robot.jointPosition('j') - target));
    });
    expect(worst).toBeLessThan(0.03);
  });

  it('servo targets are clamped to the joint limits', async () => {
    const robot = await rig('hinge', { bend: { limits: [-0.5, 0.5], ...servo(constant(2)) } });
    run(robot, 2);
    expect(robot.jointPosition('j')).toBeCloseTo(0.5, 2);
  });

  it('a weak servo cannot lift a heavy load (strength limit)', async () => {
    const strong = await rig('hinge', { bend: servo(constant(0), { maxForce: 100 }) }, { snap: 'front', childSnap: 'bottom', density: 3000 });
    run(strong, 2);
    expect(Math.abs(strong.jointPosition('j'))).toBeLessThan(0.05);
    sim!.dispose();
    sim = null;
    // Gravity needs ~0.94 N·m to hold this arm level; 0.3 N·m is not enough, so it flops down and swings.
    const weak = await rig('hinge', { bend: servo(constant(0), { maxForce: 0.3 }) }, { snap: 'front', childSnap: 'bottom', density: 3000 });
    let sag = 0;
    run(weak, 2, () => (sag = Math.max(sag, weak.jointPosition('j'))));
    expect(sag).toBeGreaterThan(1);
  });

  it('every axis of a ball joint can be driven independently', async () => {
    const robot = await rig('ball', { bend: servo(constant(0.5)), swing: servo(constant(-0.3)), twist: servo(constant(0.2)) });
    run(robot, 2);
    expect(robot.jointPosition('j', 'bend')).toBeCloseTo(0.5, 1);
    expect(robot.jointPosition('j', 'swing')).toBeCloseTo(-0.3, 1);
    expect(robot.jointPosition('j', 'twist')).toBeCloseTo(0.2, 2);
  });

  it('a slider servo extends to its target', async () => {
    const robot = await rig('slider', { slide: servo(constant(0.1)) });
    run(robot, 2);
    expect(robot.jointPosition('j')).toBeCloseTo(0.1, 2);
  });

  it('a motor spins an axle at the commanded speed', async () => {
    const robot = await rig('wheel', { spin: { drive: { mode: 'motor', signal: constant(6) } } }, { snap: 'left' });
    run(robot, 2);
    expect(robot.jointVelocity('j')).toBeCloseTo(6, 1);
    expect(robot.jointPosition('j')).toBeGreaterThan(10);
  });

  it('a keyboard signal moves the joint only while the key is held', async () => {
    const robot = await rig('hinge', { bend: servo({ kind: 'keys', positive: 'w', negative: 's', amount: 0.6 }) });
    run(robot, 1);
    expect(robot.jointPosition('j')).toBeCloseTo(0, 1);
    robot.sim.keys.add('KeyW');
    run(robot, 1);
    expect(robot.jointPosition('j')).toBeCloseTo(0.6, 1);
    robot.sim.keys.delete('KeyW');
    robot.sim.keys.add('KeyS');
    run(robot, 1);
    expect(robot.jointPosition('j')).toBeCloseTo(-0.6, 1);
  });

  it('logic can read sensors: a reflex mirrors another joint', async () => {
    const bp = new RobotBuilder('mirror')
      .root('base', 'block', { pinned: true })
      .attach('leader', 'hinge', 'base.bottom', { id: 'a', type: 'rod' }, { dofs: { bend: servo({ kind: 'wave', shape: 'sine', amplitude: 0.5, frequency: 0.5 }) } })
      .attach('follower', 'hinge', 'base.front', { id: 'b', type: 'rod', snap: 'bottom' }, {
        dofs: { bend: servo({ kind: 'expression', expr: '-angle("leader")' }) },
      })
      .spawn({ position: { x: 0, y: 1, z: 0 } })
      .build();
    sim = await Simulation.create();
    const robot = sim.addRobot(bp);
    let worst = 0;
    run(robot, 3, () => {
      if (robot.sim.time > 0.5) worst = Math.max(worst, Math.abs(robot.jointPosition('follower') + robot.jointPosition('leader')));
    });
    expect(worst).toBeLessThan(0.05);
  });

  it('code can override a signal', async () => {
    const robot = await rig('hinge', { bend: servo(constant(0.5)) });
    robot.brain.setOverride('j', 'bend', -0.4);
    run(robot, 2);
    expect(robot.jointPosition('j')).toBeCloseTo(-0.4, 2);
    robot.brain.setOverride('j', 'bend', null);
    run(robot, 2);
    expect(robot.jointPosition('j')).toBeCloseTo(0.5, 2);
  });
});

describe('building', () => {
  it('parts that overlap when snapped together ignore each other instead of exploding', async () => {
    // Two big balls on neighbouring corners of a small plate overlap each other.
    // One is welded, the other hangs on a free hinge: if they collided, it would be shoved away.
    const bp = new RobotBuilder('overlap')
      .root('plate', 'plate', { pinned: true, size: { width: 0.2, length: 0.2 } })
      .attach('a', 'weld', 'plate.bottom_fl', { id: 'ball1', type: 'sphere', size: { radius: 0.12 } })
      .attach('b', 'hinge', 'plate.bottom_fr', { id: 'ball2', type: 'sphere', size: { radius: 0.12 } })
      .spawn({ position: { x: 0, y: 1, z: 0 } })
      .build();
    sim = await Simulation.create();
    const robot = sim.addRobot(bp);
    expect(robot.notes.join()).toMatch(/"ball1" and "ball2" overlap/);
    let maxEnergy = 0;
    const err = run(robot, 2, () => (maxEnergy = Math.max(maxEnergy, robot.kineticEnergy())));
    expect(maxEnergy).toBeLessThan(1e-3);
    expect(err.gap).toBeLessThan(1e-3);
    expect(Math.abs(robot.jointPosition('b'))).toBeLessThan(0.01);
  });

  it('touch sensors report ground contact', async () => {
    const bp = new RobotBuilder('feet')
      .root('body', 'plate')
      .attach('a', 'weld', 'body.bottom_fl', { id: 'foot', type: 'sphere' })
      .attach('b', 'weld', 'body.top', { id: 'hat', type: 'block' })
      .build();
    sim = await Simulation.create();
    const robot = sim.addRobot(bp);
    run(robot, 1);
    expect(robot.touching('foot')).toBe(true);
    expect(robot.touching('hat')).toBe(false);
  });

  it('every part weighs its volume times its density', async () => {
    sim = await Simulation.create({ ground: false, gravity: 0 });
    for (const def of PART_TYPE_LIST) {
      const robot = sim.addRobot(new RobotBuilder(def.type).root('p', def.type, { density: 700 }).spawn({ position: { x: 0, y: 1, z: 0 } }).build());
      const part = robot.parts.get('p')!;
      expect(part.body.mass(), def.type).toBeCloseTo(700 * shapeVolume(part.asm.shape), 6);
    }
  });

  it('touch sensors ignore parts that are merely close to the ground', async () => {
    // Four feet hold the plate up; the belly ball hangs 1.5 cm short of the floor.
    const b = new RobotBuilder('belly').root('body', 'plate');
    for (const corner of ['fl', 'fr', 'bl', 'br']) b.attach(`leg_${corner}`, 'weld', `body.bottom_${corner}`, { id: `foot_${corner}`, type: 'sphere' });
    b.attach('belly_joint', 'weld', 'body.bottom', { id: 'belly', type: 'sphere', size: { radius: 0.0425 } });
    sim = await Simulation.create();
    const robot = sim.addRobot(b.build());
    let belly = 0;
    let feet = 0;
    const steps = run(robot, 1, () => {
      if (robot.touching('belly')) belly++;
      if (robot.touching('foot_fl')) feet++;
    });
    expect(steps.gap).toBeLessThan(1e-3);
    expect(feet).toBeGreaterThan(200);
    expect(belly).toBe(0);
  });

  it('self-collision can be switched off', async () => {
    // An arm hanging under the base swings forward into a wall that hangs off the base's front face.
    const build = (selfCollision: boolean) =>
      new RobotBuilder('wall')
        .root('base', 'block', { pinned: true })
        .attach('j', 'hinge', 'base.bottom', { id: 'arm', type: 'rod' }, { dofs: { bend: servo(constant(-1)) } })
        .attach('w', 'weld', 'base.front', { id: 'wall', type: 'plate', snap: 'top' })
        .selfCollision(selfCollision)
        .spawn({ position: { x: 0, y: 1, z: 0 } })
        .build();
    sim = await Simulation.create();
    const blocked = sim.addRobot(build(true));
    run(blocked, 1.5);
    expect(blocked.jointPosition('j')).toBeGreaterThan(-0.4);
    sim.dispose();
    sim = await Simulation.create();
    const passing = sim.addRobot(build(false));
    run(passing, 1.5);
    expect(passing.jointPosition('j')).toBeCloseTo(-1, 1);
  });
});

describe('the ground', () => {
  /** A four-wheeled cart whose axles turn at a fixed speed (rad/s). */
  const cart = (speed: number): Blueprint => {
    const b = new RobotBuilder('cart').root('chassis', 'plate');
    const drive = (sign: number): Record<string, DofSpec> => ({ spin: { drive: { mode: 'motor', gain: 6, maxForce: 6, signal: constant(sign * speed) } } });
    for (const [snap, sign] of [['left_front', 1], ['left_back', 1], ['right_front', -1], ['right_back', -1]] as const) {
      b.attach(`axle_${snap}`, 'wheel', `chassis.${snap}`, { id: `wheel_${snap}`, type: 'wheel', size: { radius: 0.1, thickness: 0.05 } }, { dofs: drive(sign) });
    }
    return b.build();
  };

  it('wheels roll smoothly instead of hopping', async () => {
    sim = await Simulation.create();
    const robot = sim.addRobot(cart(3));
    let wobble = 0;
    run(robot, 5, () => {
      if (robot.sim.time > 1) wobble = Math.max(wobble, Math.abs(robot.bodySensor('roll')), Math.abs(robot.bodySensor('pitch')));
    });
    expect(robot.telemetry().forwardDistance).toBeGreaterThan(1);
    expect(wobble).toBeLessThan(0.2 * (Math.PI / 180));
  });

  it('stays under robots that travel far', async () => {
    sim = await Simulation.create();
    const robot = sim.addRobot(cart(12));
    run(robot, 1);
    const height = robot.telemetry().height;
    run(robot, 30);
    expect(robot.telemetry().forwardDistance).toBeGreaterThan(30);
    expect(robot.telemetry().height).toBeCloseTo(height, 2);
  });
});

describe('controlling robots from code and live tuning', () => {
  it('a controller written in code can read sensors and steer joints every step', async () => {
    // A "bang-bang" controller: swing the arm towards +0.6 rad until it gets there, then back to -0.6.
    const robot = await rig('hinge', { bend: servo(constant(0)) });
    let goal = 0.6;
    let flips = 0;
    robot.sim.addController(() => {
      const angle = robot.jointPosition('j');
      if ((goal > 0 && angle > goal - 0.05) || (goal < 0 && angle < goal + 0.05)) {
        goal = -goal;
        flips++;
      }
      robot.brain.setOverride('j', 'bend', goal);
    });
    run(robot, 3);
    expect(flips).toBeGreaterThan(3);
  });

  it('retunes drives and signals while running, but refuses structural changes', async () => {
    const robot = await rig('hinge', { bend: servo(constant(0.3)) });
    run(robot, 1);
    expect(robot.jointPosition('j')).toBeCloseTo(0.3, 2);
    const t = robot.sim.time;

    const tuned = JSON.parse(JSON.stringify(robot.blueprint)) as Blueprint;
    tuned.joints[0]!.dofs!.bend!.drive = { mode: 'servo', signal: constant(-0.4) };
    expect(robot.retune(tuned)).toBe(true);
    run(robot, 1);
    expect(robot.jointPosition('j')).toBeCloseTo(-0.4, 2);
    expect(robot.sim.time).toBeGreaterThan(t); // same simulation, still running

    // From servo to free: the arm drops back down and swings.
    const floppy = JSON.parse(JSON.stringify(tuned)) as Blueprint;
    floppy.joints[0]!.dofs!.bend!.drive = { mode: 'free', friction: 0 };
    expect(robot.retune(floppy)).toBe(true);
    let max = -Infinity;
    run(robot, 1.5, () => (max = Math.max(max, robot.jointPosition('j'))));
    expect(max).toBeGreaterThan(0.3);

    const resized = JSON.parse(JSON.stringify(floppy)) as Blueprint;
    resized.parts[1]!.size = { length: 0.5 };
    expect(robot.retune(resized)).toBe(false);
  });
});
