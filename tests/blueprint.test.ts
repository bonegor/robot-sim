import { describe, expect, it } from 'vitest';
import {
  type Blueprint,
  BlueprintError,
  findChannelCycle,
  keysUsed,
  parseBlueprint,
  serializeBlueprint,
  subtreeOf,
  uniqueId,
  usedSnaps,
  validateBlueprint,
} from '../src/core/blueprint';
import { RobotBuilder } from '../src/core/builder';
import { assemble } from '../src/core/assembly';

const base = () =>
  new RobotBuilder('test')
    .root('body', 'plate')
    .attach('hip', 'hinge', 'body.bottom_fl', { id: 'leg', type: 'bone' })
    .attach('knee', 'hinge', 'leg.bottom', { id: 'shin', type: 'bone' });

const messages = (bp: Blueprint) => validateBlueprint(bp).errors.map((e) => e.message).join('\n');

describe('blueprint validation', () => {
  it('accepts a well-formed robot', () => {
    const res = validateBlueprint(base().build());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('rejects an empty robot', () => {
    expect(messages({ ...base().draft(), parts: [], joints: [] })).toMatch(/at least one part/);
  });

  it('rejects duplicate ids', () => {
    const bp = base().draft();
    bp.parts[2]!.id = 'leg';
    expect(messages(bp)).toMatch(/Duplicate id "leg"/);
  });

  it('rejects ids that expressions could not refer to', () => {
    const bp = base().draft();
    bp.parts[1]!.id = 'left leg';
    expect(messages(bp)).toMatch(/must start with a letter/);
  });

  it('rejects unknown part and joint types', () => {
    const bp = base().draft();
    (bp.parts[1] as { type: string }).type = 'tentacle';
    (bp.joints[1] as { type: string }).type = 'telepathy';
    const m = messages(bp);
    expect(m).toMatch(/Unknown part type "tentacle"/);
    expect(m).toMatch(/Unknown joint type "telepathy"/);
  });

  it('rejects snap points that do not exist, listing the ones that do', () => {
    const bp = base().draft();
    bp.joints[0]!.parent.snap = 'nose';
    expect(messages(bp)).toMatch(/no snap point "nose" \(try: top, bottom/);
  });

  it('rejects using one snap point for two connections', () => {
    const bp = base().draft();
    bp.parts.push({ id: 'extra', type: 'rod' });
    bp.joints.push({ id: 'j2', type: 'weld', parent: { part: 'body', snap: 'bottom_fl' }, child: { part: 'extra', snap: 'top' } });
    expect(messages(bp)).toMatch(/already used by joint "hip"/);
  });

  it('rejects a part with two parents', () => {
    const bp = base().draft();
    bp.joints.push({ id: 'j2', type: 'weld', parent: { part: 'body', snap: 'bottom_fr' }, child: { part: 'shin', snap: 'mid_left' } });
    expect(messages(bp)).toMatch(/only have one parent/);
  });

  it('rejects connecting a part to itself', () => {
    const bp = base().draft();
    bp.joints.push({ id: 'j2', type: 'weld', parent: { part: 'body', snap: 'top' }, child: { part: 'body', snap: 'front' } });
    expect(messages(bp)).toMatch(/to itself/);
  });

  it('rejects loops of joints', () => {
    const bp = base().draft();
    // body → leg → shin, then shin → body closes a loop and leaves no root.
    bp.joints.push({ id: 'j2', type: 'weld', parent: { part: 'shin', snap: 'bottom' }, child: { part: 'body', snap: 'top' } });
    expect(messages(bp)).toMatch(/loop/);
  });

  it('rejects parts that are not connected', () => {
    const bp = base().draft();
    bp.parts.push({ id: 'floater', type: 'sphere' });
    expect(messages(bp)).toMatch(/"floater" is not connected/);
  });

  it('rejects unknown DOF names and bad limits', () => {
    const bp = base().draft();
    bp.joints[0]!.dofs = { twist: {}, bend: { limits: [1, -1] } };
    const m = messages(bp);
    expect(m).toMatch(/Hinge joint has no "twist" \(it has: bend\)/);
    expect(m).toMatch(/min ≤ max/);
  });

  it('rejects driven joints whose signal does not compile', () => {
    const bp = base().draft();
    bp.joints[0]!.dofs = { bend: { drive: { mode: 'servo', signal: { kind: 'expression', expr: 'sin(' } } } };
    expect(messages(bp)).toMatch(/Unexpected|Expected/);
    bp.joints[0]!.dofs = { bend: { drive: { mode: 'servo', signal: { kind: 'expression', expr: 'angle("ankle")' } } } };
    expect(messages(bp)).toMatch(/Unknown joint "ankle"/);
  });

  it('accepts signals that read other joints, parts and channels', () => {
    const bp = base().channel('gait', { kind: 'wave', shape: 'sine', amplitude: 1, frequency: 1 }).draft();
    bp.joints[1]!.dofs = {
      bend: { drive: { mode: 'servo', signal: { kind: 'expression', expr: '0.3 * gait + angle("hip") * touching("shin")' } } },
    };
    expect(validateBlueprint(bp).errors).toEqual([]);
  });

  it('rejects channels with reserved names and circular channel dependencies', () => {
    const bp = base().draft();
    bp.channels = {
      t: { kind: 'constant', value: 1 },
      a: { kind: 'expression', expr: 'b + 1' },
      b: { kind: 'channel', name: 'a' },
    };
    const m = messages(bp);
    expect(m).toMatch(/"t" is a built-in name/);
    expect(m).toMatch(/loop: (a → b → a|b → a → b)/);
  });

  it('warns about out-of-range sizes instead of failing', () => {
    const bp = base().draft();
    bp.parts[1]!.size = { length: 50 };
    const res = validateBlueprint(bp);
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.message).join()).toMatch(/clamped/);
  });

  it('round-trips through JSON', () => {
    const bp = base().channel('gait', { kind: 'wave', shape: 'triangle', amplitude: 0.4, frequency: 2, phase: 0.25 }).build();
    const again = parseBlueprint(serializeBlueprint(bp));
    expect(again).toEqual(bp);
    const a = assemble(bp);
    const b = assemble(again);
    for (const [id, part] of a.parts) expect(b.parts.get(id)!.pose).toEqual(part.pose);
  });

  it('gives readable errors for broken JSON', () => {
    expect(() => parseBlueprint('{ nope')).toThrow(BlueprintError);
    expect(() => parseBlueprint('{"parts": 3, "joints": []}')).toThrow(/parts must be a list/);
  });
});

describe('blueprint helpers', () => {
  it('finds subtrees and used snaps', () => {
    const bp = base().build();
    expect([...subtreeOf(bp, 'leg')].sort()).toEqual(['leg', 'shin']);
    expect([...usedSnaps(bp, 'leg')].sort()).toEqual(['bottom', 'top']);
  });

  it('generates fresh ids', () => {
    const bp = base().build();
    expect(uniqueId(bp, 'leg')).toBe('leg1');
    bp.parts.push({ id: 'leg1', type: 'rod' });
    expect(uniqueId(bp, 'leg')).toBe('leg2');
    expect(uniqueId(bp, '9 lives')).toBe('lives1');
  });

  it('detects channel cycles', () => {
    expect(findChannelCycle(new Map([['a', new Set(['b'])], ['b', new Set<string>()]]))).toBeNull();
    expect(findChannelCycle(new Map([['a', new Set(['a'])]]))).toEqual(['a', 'a']);
  });
});

describe('keysUsed', () => {
  it('lists the keys a robot listens to, from keyboard signals and logic', async () => {
    const { rover, arm, dog } = await import('../src/presets');
    expect(keysUsed(rover()).sort()).toEqual(['A', 'D', 'S', 'W', '↑', '↓', '←', '→'].sort());
    expect(keysUsed(arm())).toEqual(expect.arrayContaining(['Q', 'E', 'W', 'S', 'A', 'D', 'Z', 'X', 'C', 'V']));
    expect(keysUsed(dog())).toEqual([]);
  });
});
