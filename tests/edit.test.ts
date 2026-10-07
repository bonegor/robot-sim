/**
 * Builder operations: snapping a robot together the way a player would, one click at a time.
 */
import { describe, expect, it } from 'vitest';
import { assemble, snapAlignment } from '../src/core/assembly';
import { validateBlueprint } from '../src/core/blueprint';
import {
  attachPart,
  changeJointType,
  freeSnaps,
  oppositeSnap,
  removePart,
  setChannel,
  setDriveMode,
  setPartSize,
  setRoot,
  setSignal,
  updateJoint,
} from '../src/core/edit';
import { emptyBlueprint } from '../src/core/blueprint';
import { Simulation } from '../src/physics/simulation';

describe('builder operations', () => {
  it('builds a little walker click by click, staying valid at every step', async () => {
    let { blueprint: bp, partId: body } = setRoot(emptyBlueprint('Walker'), 'plate');
    expect(validateBlueprint(bp).ok).toBe(true);

    const corners = ['bottom_fl', 'bottom_fr', 'bottom_bl', 'bottom_br'];
    const hips: string[] = [];
    for (const corner of corners) {
      const thigh = attachPart(bp, { part: body, snap: corner }, 'bone', 'hinge');
      bp = thigh.blueprint;
      hips.push(thigh.jointId!);
      // Chain the shin onto the far end of the thigh.
      const far = oppositeSnap('top')!;
      const shin = attachPart(bp, { part: thigh.partId, snap: far }, 'bone', 'hinge');
      bp = shin.blueprint;
      expect(validateBlueprint(bp).errors).toEqual([]);
    }
    expect(bp.parts).toHaveLength(9);
    expect(bp.joints).toHaveLength(8);

    // Make the hips walk and the knees stay floppy.
    hips.forEach((hip, i) => {
      bp = setDriveMode(bp, hip, 'bend', 'servo');
      bp = setSignal(bp, hip, 'bend', { kind: 'wave', shape: 'sine', amplitude: 0.3, frequency: 1.5, phase: i === 0 || i === 3 ? 0 : 0.5 });
    });
    expect(validateBlueprint(bp).errors).toEqual([]);

    // Every joint is snapped tight.
    const asm = assemble(bp);
    for (const j of asm.joints.keys()) expect(snapAlignment(asm, j).gap).toBeLessThan(1e-9);

    // And it actually simulates.
    const sim = await Simulation.create();
    const robot = sim.addRobot(bp);
    expect(robot.brain.driven).toHaveLength(4);
    sim.advance(2);
    expect(robot.worstConnection().gap).toBeLessThan(3e-3);
    sim.dispose();
  });

  it('only offers snaps that are still free', () => {
    const { blueprint, partId } = setRoot(emptyBlueprint(), 'rod');
    const before = freeSnaps(blueprint, partId).map((s) => s.id);
    const next = attachPart(blueprint, { part: partId, snap: 'bottom' }, 'sphere', 'weld');
    const after = freeSnaps(next.blueprint, partId).map((s) => s.id);
    expect(before).toContain('bottom');
    expect(after).not.toContain('bottom');
    expect(freeSnaps(next.blueprint, next.partId).map((s) => s.id)).not.toContain('top');
    expect(() => attachPart(next.blueprint, { part: partId, snap: 'bottom' }, 'rod', 'hinge')).toThrow(/already in use/);
  });

  it('removes a part together with everything hanging off it', () => {
    let { blueprint: bp, partId: root } = setRoot(emptyBlueprint(), 'plate');
    const a = attachPart(bp, { part: root, snap: 'bottom_fl' }, 'rod', 'hinge');
    const b = attachPart(a.blueprint, { part: a.partId, snap: 'bottom' }, 'rod', 'hinge');
    const c = attachPart(b.blueprint, { part: root, snap: 'bottom_fr' }, 'rod', 'hinge');
    bp = removePart(c.blueprint, a.partId);
    expect(bp.parts.map((p) => p.id).sort()).toEqual([root, c.partId].sort());
    expect(bp.joints.map((j) => j.id)).toEqual([c.jointId]);
    expect(validateBlueprint(bp).ok).toBe(true);
  });

  it('keeps shared DOF settings when the joint type changes', () => {
    let { blueprint: bp, partId: root } = setRoot(emptyBlueprint(), 'block');
    const a = attachPart(bp, { part: root, snap: 'top' }, 'rod', 'ball');
    bp = setDriveMode(a.blueprint, a.jointId!, 'bend', 'spring');
    bp = setDriveMode(bp, a.jointId!, 'twist', 'servo');
    bp = changeJointType(bp, a.jointId!, 'hinge');
    const j = bp.joints[0]!;
    expect(Object.keys(j.dofs ?? {})).toEqual(['bend']);
    expect(j.dofs?.bend?.drive?.mode).toBe('spring');
    expect(validateBlueprint(bp).ok).toBe(true);
  });

  it('keeps the signal when switching between servo and motor', () => {
    let { blueprint: bp, partId: root } = setRoot(emptyBlueprint(), 'block');
    const a = attachPart(bp, { part: root, snap: 'left' }, 'wheel', 'wheel');
    bp = setDriveMode(a.blueprint, a.jointId!, 'spin', 'servo');
    bp = setSignal(bp, a.jointId!, 'spin', { kind: 'constant', value: 3 });
    bp = setDriveMode(bp, a.jointId!, 'spin', 'motor');
    expect(bp.joints[0]!.dofs?.spin?.drive).toMatchObject({ mode: 'motor', signal: { kind: 'constant', value: 3 } });
  });

  it('re-snaps parts when sizes or joint angles change', () => {
    let { blueprint: bp, partId: root } = setRoot(emptyBlueprint(), 'plate');
    const a = attachPart(bp, { part: root, snap: 'bottom_fl' }, 'rod', 'hinge');
    bp = setPartSize(a.blueprint, root, 'width', 0.8);
    bp = updateJoint(bp, a.jointId!, { angle: Math.PI / 4 });
    const asm = assemble(bp);
    expect(snapAlignment(asm, a.jointId!).gap).toBeLessThan(1e-9);
    expect(asm.parts.get(a.partId)!.pose.p.x).toBeGreaterThan(0.3);
  });

  it('manages channels without touching the input', () => {
    const { blueprint } = setRoot(emptyBlueprint(), 'plate');
    const withClock = setChannel(blueprint, 'clock', { kind: 'wave', shape: 'sine', amplitude: 1, frequency: 1 });
    expect(Object.keys(withClock.channels!)).toEqual(['clock']);
    expect(Object.keys(blueprint.channels!)).toEqual([]);
    expect(Object.keys(setChannel(withClock, 'clock', null).channels!)).toEqual([]);
  });
});
