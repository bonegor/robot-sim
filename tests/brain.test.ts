import { describe, expect, it } from 'vitest';
import { assemble } from '../src/core/assembly';
import { Brain, type BrainSenses } from '../src/core/brain';
import { cloneBlueprint } from '../src/core/blueprint';
import { RobotBuilder } from '../src/core/builder';

const senses = (over: Partial<BrainSenses> = {}): BrainSenses => ({
  keyDown: () => false,
  jointPosition: () => 0,
  jointVelocity: () => 0,
  touching: () => false,
  bodySensor: () => 0,
  ...over,
});

const robot = () =>
  new RobotBuilder('brainy')
    .root('body', 'plate')
    .channel('clock', { kind: 'wave', shape: 'saw', amplitude: 1, frequency: 1 })
    .channel('double', { kind: 'expression', expr: '2 * clock' })
    .attach('a', 'hinge', 'body.bottom_fl', { id: 'l1', type: 'rod' }, { dofs: { bend: { drive: { mode: 'servo', signal: { kind: 'channel', name: 'double', gain: 0.5 } } } } })
    .attach('b', 'wheel', 'body.left_front', { id: 'w', type: 'wheel' }, { dofs: { spin: { drive: { mode: 'motor', signal: { kind: 'keys', positive: 'up', amount: 5 } } } } })
    .attach('c', 'hinge', 'body.bottom_fr', { id: 'l2', type: 'rod' })
    .attach('d', 'ball', 'body.bottom_bl', { id: 'l3', type: 'rod' }, {
      dofs: { swing: { drive: { mode: 'servo', signal: { kind: 'expression', expr: 'touching("l2") ? 1 : -1' } } } },
    })
    .build();

describe('brain', () => {
  it('collects only the driven DOFs', () => {
    const brain = new Brain(assemble(robot()));
    expect(brain.driven.map((d) => `${d.key}:${d.mode}`).sort()).toEqual(['a.bend:servo', 'b.spin:motor', 'd.swing:servo']);
  });

  it('evaluates channels (including chained ones) once per tick', () => {
    const brain = new Brain(assemble(robot()));
    const targets = brain.tick(0.25, 0.01, senses());
    expect(brain.channelValues().get('clock')).toBeCloseTo(0.5);
    expect(brain.channelValues().get('double')).toBeCloseTo(1);
    expect(targets.get('a.bend')).toBeCloseTo(0.5);
  });

  it('reads keys and sensors through its senses', () => {
    const brain = new Brain(assemble(robot()));
    let targets = brain.tick(0, 0.01, senses());
    expect(targets.get('b.spin')).toBe(0);
    expect(targets.get('d.swing')).toBe(-1);
    targets = brain.tick(0.01, 0.01, senses({ keyDown: (k) => k === 'ArrowUp', touching: (p) => p === 'l2' }));
    expect(targets.get('b.spin')).toBe(5);
    expect(targets.get('d.swing')).toBe(1);
  });

  it('hands the state of unchanged signals on to the brain that replaces it', () => {
    const bp = robot();
    bp.channels!.clock = { kind: 'expression', expr: 'integrate(1)' };
    const first = new Brain(assemble(bp));
    for (let i = 1; i <= 50; i++) first.tick(i * 0.01, 0.01, senses());
    first.setOverride('b', 'spin', 2);

    // Another gain on one joint: the clock keeps counting and the override stays.
    const tuned = cloneBlueprint(bp);
    tuned.joints.find((j) => j.id === 'a')!.dofs!.bend!.drive = { mode: 'servo', signal: { kind: 'channel', name: 'double', gain: 0.25 } };
    const second = new Brain(assemble(tuned), first);
    const targets = second.tick(0.51, 0.01, senses());
    expect(second.channelValues().get('clock')).toBeCloseTo(0.51);
    expect(targets.get('a.bend')).toBeCloseTo(0.25 * 2 * 0.51);
    expect(targets.get('b.spin')).toBe(2);

    // A channel that changed starts afresh.
    const changed = cloneBlueprint(tuned);
    changed.channels!.clock = { kind: 'expression', expr: 'integrate(2)' };
    const third = new Brain(assemble(changed), second);
    third.tick(0.52, 0.01, senses());
    expect(third.channelValues().get('clock')).toBeCloseTo(0.02);
  });

  it('lets code override a signal and hand control back', () => {
    const brain = new Brain(assemble(robot()));
    brain.setOverride('a', 'bend', 0.3);
    expect(brain.tick(0.25, 0.01, senses()).get('a.bend')).toBe(0.3);
    brain.setOverride('a', 'bend', null);
    expect(brain.tick(0.25, 0.01, senses()).get('a.bend')).toBeCloseTo(0.5);
  });
});
