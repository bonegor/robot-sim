/**
 * Whole-robot scenarios: each preset is simulated and must do its job
 * while every joint stays connected.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateBlueprint } from '../src/core/blueprint';
import { qrotate, v3 } from '../src/core/math';
import { PRESETS, arm, dog, hexapod, pendulum, rover, snake } from '../src/presets';
import { type Robot, Simulation } from '../src/physics/simulation';
import type { Blueprint } from '../src/core/blueprint';

let sim: Simulation | null = null;
afterEach(() => {
  sim?.dispose();
  sim = null;
});

interface RunStats {
  maxTilt: number;
  maxGap: number;
  maxAngle: number;
}

async function spawn(bp: Blueprint, solverIterations?: number): Promise<Robot> {
  sim = await Simulation.create(solverIterations ? { solverIterations } : {});
  return sim.addRobot(bp);
}

function run(robot: Robot, seconds: number, each?: (t: number) => void): RunStats {
  const stats: RunStats = { maxTilt: 0, maxGap: 0, maxAngle: 0 };
  const steps = Math.round(seconds / robot.sim.timestep);
  for (let i = 0; i < steps; i++) {
    robot.sim.step();
    stats.maxTilt = Math.max(stats.maxTilt, robot.telemetry().tilt);
    const w = robot.worstConnection();
    stats.maxGap = Math.max(stats.maxGap, w.gap);
    stats.maxAngle = Math.max(stats.maxAngle, w.angle);
    each?.(robot.sim.time);
  }
  return stats;
}

const DEG = Math.PI / 180;

describe('presets', () => {
  for (const preset of PRESETS) {
    it(`${preset.name} is a valid blueprint that spawns without overlaps or explosions`, async () => {
      const bp = preset.build();
      expect(validateBlueprint(bp).errors).toEqual([]);
      const robot = await spawn(bp);
      expect(robot.notes).toEqual([]);
      let maxEnergy = 0;
      const stats = run(robot, 2, () => (maxEnergy = Math.max(maxEnergy, robot.kineticEnergy() / robot.totalMass())));
      expect(stats.maxGap).toBeLessThan(5e-3);
      expect(maxEnergy).toBeLessThan(5); // J/kg: nothing is flung across the room
    });
  }
});

describe('dog', () => {
  it('trots forward without falling over and its joints stay connected', async () => {
    const robot = await spawn(dog());
    const stats = run(robot, 10);
    const t = robot.telemetry();
    expect(t.forwardDistance).toBeGreaterThan(1.5);
    expect(Math.abs(t.distance - t.forwardDistance)).toBeLessThan(0.5); // mostly straight
    expect(stats.maxTilt).toBeLessThan(30 * DEG);
    expect(stats.maxGap).toBeLessThan(3e-3);
    expect(stats.maxAngle).toBeLessThan(0.1);
  });

  it('walks for any solver quality between 8 and 16 iterations', async () => {
    for (const iterations of [8, 16]) {
      const robot = await spawn(dog(), iterations);
      const stats = run(robot, 8);
      expect(robot.telemetry().forwardDistance, `${iterations} iterations`).toBeGreaterThan(0.8);
      expect(stats.maxTilt).toBeLessThan(45 * DEG);
      sim!.dispose();
      sim = null;
    }
  });

  it('stands still when the gait is switched off', async () => {
    const bp = dog({ stride: 0, lift: 0 });
    const robot = await spawn(bp);
    run(robot, 5);
    expect(robot.telemetry().distance).toBeLessThan(0.05);
    expect(robot.telemetry().tilt).toBeLessThan(5 * DEG);
  });

  it('has passive and driven joints side by side', async () => {
    const robot = await spawn(dog());
    const modes = new Map<string, string>();
    for (const s of robot.dofs.values()) modes.set(s.key, s.config.drive.mode);
    expect(modes.get('hip_fl.bend')).toBe('servo');
    expect(modes.get('knee_hr.bend')).toBe('servo');
    expect(modes.get('tail_tip.swing')).toBe('spring');
    expect(robot.brain.driven.map((d) => d.key)).not.toContain('tail_tip.swing');
    // The springy tail moves even though nothing drives it.
    const seen = new Set<number>();
    run(robot, 3, () => seen.add(Math.round(robot.jointPosition('tail_tip', 'bend') * 100)));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('hexapod', () => {
  it('walks forward with a tripod gait', async () => {
    const robot = await spawn(hexapod());
    const stats = run(robot, 10);
    expect(robot.telemetry().forwardDistance).toBeGreaterThan(1);
    expect(stats.maxTilt).toBeLessThan(20 * DEG);
    expect(stats.maxGap).toBeLessThan(3e-3);
  });
});

describe('rover', () => {
  it('sits still until a key is pressed', async () => {
    const robot = await spawn(rover());
    run(robot, 2);
    expect(robot.telemetry().distance).toBeLessThan(0.02);
  });

  it('drives forward on ↑ and backward on ↓', async () => {
    const robot = await spawn(rover());
    robot.sim.keys.add('ArrowUp');
    run(robot, 3);
    const ahead = robot.telemetry().forwardDistance;
    expect(ahead).toBeGreaterThan(2);
    robot.sim.keys.clear();
    robot.sim.keys.add('KeyS');
    run(robot, 4);
    expect(robot.telemetry().forwardDistance).toBeLessThan(ahead - 1);
  });

  it('turns left on ← and right on →', async () => {
    const heading = async (key: string) => {
      const robot = await spawn(rover());
      robot.sim.keys.add(key);
      run(robot, 0.75); // short enough that the heading cannot wrap past ±π
      const yaw = robot.bodySensor('yaw');
      sim!.dispose();
      sim = null;
      return yaw;
    };
    // Facing +Z, turning left (counter-clockwise seen from above) swings the nose towards +X.
    expect(await heading('ArrowLeft')).toBeGreaterThan(0.3);
    expect(await heading('ArrowRight')).toBeLessThan(-0.3);
  });

  it('wobbles its passive antenna when it brakes', async () => {
    const robot = await spawn(rover());
    robot.sim.keys.add('ArrowUp');
    run(robot, 2);
    robot.sim.keys.clear();
    let swing = 0;
    run(robot, 1, () => (swing = Math.max(swing, Math.abs(robot.jointPosition('mast2', 'bend')))));
    expect(swing).toBeGreaterThan(0.05);
  });
});

describe('snake', () => {
  it('slithers forward using a travelling wave and free wheels', async () => {
    const robot = await spawn(snake());
    const stats = run(robot, 10);
    expect(robot.telemetry().forwardDistance).toBeGreaterThan(2);
    expect(stats.maxTilt).toBeLessThan(15 * DEG);
  });

  it('bends left/right, not up/down', async () => {
    const robot = await spawn(snake());
    for (const j of robot.assembly.joints.values()) {
      if (!j.spec.id.startsWith('spine')) continue;
      expect(Math.abs(qrotate(j.worldFrame.q, v3(1, 0, 0)).y), j.spec.id).toBeCloseTo(1, 6);
    }
  });

  it('owes its motion to the wave: frozen joints barely move', async () => {
    const travel = async (wave: boolean) => {
      const bp = snake();
      for (const j of bp.joints) {
        const drive = j.dofs?.bend?.drive;
        if (drive?.mode === 'servo' && !wave) drive.signal = { kind: 'constant', value: 0 };
      }
      const robot = await spawn(bp);
      run(robot, 6);
      const d = robot.telemetry().distance;
      sim!.dispose();
      sim = null;
      return d;
    };
    // On nearly frictionless wheels a straight snake can still roll a little after landing.
    expect(await travel(true)).toBeGreaterThan(10 * (await travel(false)));
  });
});

describe('arm', () => {
  it('stays bolted to the floor and holds its pose', async () => {
    const robot = await spawn(arm());
    const before = robot.partPose('base');
    const stats = run(robot, 2);
    expect(robot.partPose('base').p).toEqual(before.p);
    expect(robot.jointPosition('shoulder')).toBeCloseTo(0.3, 1);
    expect(stats.maxGap).toBeLessThan(1e-3);
  });

  it('jogs joints from the keyboard and keeps them where they were left', async () => {
    const robot = await spawn(arm());
    robot.sim.keys.add('KeyQ');
    run(robot, 1);
    robot.sim.keys.clear();
    run(robot, 1);
    const turned = robot.jointPosition('turntable');
    expect(turned).toBeGreaterThan(1);
    run(robot, 1);
    expect(robot.jointPosition('turntable')).toBeCloseTo(turned, 2);
  });

  it('lets the fingers dangle freely', async () => {
    const robot = await spawn(arm());
    robot.sim.keys.add('KeyA');
    let range = { lo: Infinity, hi: -Infinity };
    run(robot, 2, () => {
      const p = robot.jointPosition('finger_l');
      range = { lo: Math.min(range.lo, p), hi: Math.max(range.hi, p) };
    });
    expect(range.hi - range.lo).toBeGreaterThan(0.2);
  });
});

describe('pendulum chain', () => {
  it('swings chaotically with only free joints, losing little energy', async () => {
    const robot = await spawn(pendulum());
    expect(robot.brain.driven).toEqual([]);
    const energy = () => {
      let e = robot.kineticEnergy();
      for (const p of robot.parts.values()) if (p.body.isDynamic()) e += p.body.mass() * 9.81 * p.body.translation().y;
      return e;
    };
    run(robot, 0.05);
    const start = energy();
    const stats = run(robot, 5);
    const end = energy();
    expect(stats.maxGap).toBeLessThan(2e-3);
    expect(end).toBeLessThan(start + 0.05); // no energy from nowhere
    expect(end).toBeGreaterThan(start - 0.35 * Math.abs(start)); // and not much lost either
  });
});

describe('the example blueprint file', () => {
  it('examples/kicker.json loads, validates and kicks on Space', async () => {
    const { readFileSync } = await import('node:fs');
    const { parseBlueprint } = await import('../src/core/blueprint');
    const bp = parseBlueprint(readFileSync(new URL('../examples/kicker.json', import.meta.url), 'utf8'));
    const robot = await spawn(bp);
    run(robot, 1);
    expect(robot.jointPosition('knee')).toBeCloseTo(0.2, 1);
    robot.sim.keys.add('Space');
    run(robot, 1);
    expect(robot.jointPosition('knee')).toBeCloseTo(-1.2, 1);
  });
});
