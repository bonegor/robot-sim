import { describe, expect, it } from 'vitest';
import {
  assemble,
  assemblyBounds,
  dofPositions,
  dofTransform,
  snapAlignment,
  snapWorldFrame,
  spawnRootPose,
} from '../src/core/assembly';
import { type Blueprint, validateBlueprint } from '../src/core/blueprint';
import { RobotBuilder } from '../src/core/builder';
import { JOINT_TYPE_LIST, type JointType, getJointType } from '../src/core/joints';
import { composePose, dot, invertPose, qrotate, transformPoint, v3 } from '../src/core/math';
import { PART_TYPE_LIST, type PartType, getSnaps, resolveSize } from '../src/core/parts';

const pair = (parentType: PartType, parentSnap: string, childType: PartType, childSnap: string, joint: JointType = 'hinge', angle = 0): Blueprint =>
  new RobotBuilder('pair')
    .root('a', parentType)
    .attach('j', joint, { part: 'a', snap: parentSnap }, { id: 'b', type: childType, snap: childSnap }, { angle })
    .build();

describe('snap assembly', () => {
  it('connects every part type to every other part type at every pair of snap points', () => {
    let checked = 0;
    for (const parent of PART_TYPE_LIST) {
      for (const child of PART_TYPE_LIST) {
        const parentSnaps = getSnaps(parent.type, resolveSize(parent.type));
        const childSnaps = getSnaps(child.type, resolveSize(child.type));
        for (const ps of parentSnaps) {
          for (const cs of childSnaps) {
            const asm = assemble(pair(parent.type, ps.id, child.type, cs.id), { trusted: true });
            const a = snapAlignment(asm, 'j');
            expect(a.gap, `${parent.type}.${ps.id} ← ${child.type}.${cs.id}`).toBeLessThan(1e-9);
            expect(a.normalDot).toBeCloseTo(-1, 9);
            expect(a.upDot).toBeCloseTo(1, 9);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('places the child on the outside of the parent', () => {
    const asm = assemble(pair('plate', 'bottom_fl', 'bone', 'top'));
    const plate = asm.parts.get('a')!;
    const bone = asm.parts.get('b')!;
    expect(bone.pose.p.y).toBeLessThan(plate.pose.p.y);
    // The bone hangs straight down from the corner, half its length below the plate's underside.
    const bottom = -resolveSize('plate').thickness / 2;
    expect(bone.pose.p.y).toBeCloseTo(bottom - resolveSize('bone').length / 2, 9);
  });

  it('turns the child (and the joint axes) about the connection axis with `angle`', () => {
    const asm = assemble(pair('block', 'top', 'plate', 'bottom', 'hinge', Math.PI / 2));
    const plate = asm.parts.get('b')!;
    // Unturned, the plate's length runs along world Z; a quarter turn about the vertical swings it onto X.
    const along = qrotate(plate.pose.q, v3(0, 0, 1));
    expect(Math.abs(along.x)).toBeCloseTo(1, 9);
    expect(snapAlignment(asm, 'j').gap).toBeLessThan(1e-9);
    // Hinge axis (joint X) was world X for the unturned block top; now it is along Z.
    const axis = qrotate(asm.joints.get('j')!.worldFrame.q, v3(1, 0, 0));
    expect(Math.abs(axis.z)).toBeCloseTo(1, 9);
  });

  it('makes a hinge on a plate corner swing the leg forward/backward', () => {
    const asm = assemble(pair('plate', 'bottom_fl', 'rod', 'top'));
    const axis = qrotate(asm.joints.get('j')!.worldFrame.q, v3(1, 0, 0));
    expect(Math.abs(axis.x)).toBeCloseTo(1, 9); // sideways axis → forward/back swing
  });

  it('applies initial DOF positions and reads them back', () => {
    const cases: [JointType, Record<string, number>][] = [
      ['hinge', { bend: 0.7 }],
      ['pivot', { twist: -0.4 }],
      ['ball', { bend: 0.3, swing: -0.2, twist: 0.1 }],
      ['saddle', { bend: -0.5, swing: 0.25 }],
      ['slider', { slide: 0.08 }],
      ['gliding', { shift_side: 0.01, shift_up: -0.015 }],
      ['wheel', { spin: 2.5 }],
    ];
    for (const [type, values] of cases) {
      const bp = new RobotBuilder('x')
        .root('a', 'block')
        .attach('j', type, 'a.top', { id: 'b', type: 'rod' }, {
          dofs: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { initial: v }])),
        })
        .build();
      const asm = assemble(bp);
      const j = asm.joints.get('j')!;
      const child = asm.parts.get('b')!;
      const childFrameWorld = composePose(child.pose, j.frameInChild);
      const rel = composePose(invertPose(j.worldFrame), childFrameWorld);
      const read = dofPositions(j.def.dofs, rel);
      j.def.dofs.forEach((d, i) => expect(read[i], `${type}.${d.name}`).toBeCloseTo(values[d.name] ?? 0, 9));
    }
  });

  it('round-trips DOF transforms for every joint type', () => {
    for (const def of JOINT_TYPE_LIST) {
      const values = def.dofs.map((d, i) => (d.kind === 'angular' ? 0.3 - 0.2 * i : 0.01 * (i + 1)));
      const back = dofPositions(def.dofs, dofTransform(def.dofs, values));
      values.forEach((v, i) => expect(back[i], `${def.type}`).toBeCloseTo(v, 9));
    }
  });

  it('assembles long chains without accumulating error', () => {
    const b = new RobotBuilder('chain').root('seg0', 'rod');
    for (let i = 1; i <= 30; i++) {
      b.attach(`j${i}`, i % 3 === 0 ? 'ball' : 'hinge', `seg${i - 1}.bottom`, { id: `seg${i}`, type: 'rod' }, {
        angle: i * 0.37,
        dofs: i % 3 === 0 ? { bend: { initial: 0.2 }, swing: { initial: -0.1 } } : { bend: { initial: 0.15 } },
      });
    }
    const asm = assemble(b.build());
    for (let i = 1; i <= 30; i++) {
      const j = asm.joints.get(`j${i}`)!;
      const pa = transformPoint(snapWorldFrame(asm.parts.get(j.parent)!, j.spec.parent.snap), v3());
      const pb = transformPoint(snapWorldFrame(asm.parts.get(j.child)!, j.spec.child.snap), v3());
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)).toBeLessThan(1e-9);
    }
  });

  it('keeps a slider child on the axis, pushed out by its extension', () => {
    const bp = new RobotBuilder('x')
      .root('a', 'block')
      .attach('j', 'slider', 'a.front', { id: 'b', type: 'block', snap: 'back' }, { dofs: { slide: { initial: 0.1 } } })
      .build();
    const asm = assemble(bp);
    const a = snapWorldFrame(asm.parts.get('a')!, 'front');
    const b = snapWorldFrame(asm.parts.get('b')!, 'back');
    const gap = transformPoint(b, v3());
    const n = qrotate(a.q, v3(0, 0, 1));
    const d = v3(gap.x - a.p.x, gap.y - a.p.y, gap.z - a.p.z);
    expect(dot(d, n)).toBeCloseTo(0.1, 9);
  });

  it('spawns robots standing on the ground', () => {
    const bp = pair('plate', 'bottom_fl', 'bone', 'top');
    const pose = spawnRootPose(bp);
    const asm = assemble(bp, { rootPose: pose });
    expect(assemblyBounds(asm).min.y).toBeCloseTo(0.02, 9);
  });

  it('respects the yaw of the spawn', () => {
    const bp = pair('plate', 'front', 'block', 'back');
    bp.spawn = { yaw: Math.PI / 2 };
    const asm = assemble(bp, { rootPose: spawnRootPose(bp) });
    const fwd = qrotate(asm.parts.get('a')!.pose.q, v3(0, 0, 1));
    expect(fwd.x).toBeCloseTo(1, 9);
    expect(validateBlueprint(bp).ok).toBe(true);
  });

  it('exposes every joint type with consistent DOF definitions', () => {
    for (const def of JOINT_TYPE_LIST) {
      expect(getJointType(def.type)).toBe(def);
      const names = def.dofs.map((d) => d.name);
      expect(new Set(names).size).toBe(names.length);
      const axes = def.dofs.map((d) => d.axis);
      expect(new Set(axes).size).toBe(axes.length);
      for (const d of def.dofs) {
        expect(d.kind).toBe(d.axis.startsWith('ang') ? 'angular' : 'linear');
        if (d.limits) expect(d.limits[0]).toBeLessThanOrEqual(d.limits[1]);
      }
    }
  });
});
