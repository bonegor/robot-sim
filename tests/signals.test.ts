import { describe, expect, it } from 'vitest';
import {
  type BodySensorName,
  type ExpressionRuntime,
  WAVES,
  checkExpression,
  compileExpression,
  normalizeKey,
} from '../src/core/expression';
import { compileSignal, describeSignal, signalError } from '../src/core/signals';

/** A fake runtime with controllable time, keys and sensors. */
function runtime(over: Partial<{ t: number; dt: number; keys: string[]; channels: Record<string, number>; joints: Record<string, number>; body: Partial<Record<BodySensorName, number>>; touching: string[] }> = {}) {
  const state = { t: 0, dt: 0.01, keys: new Set<string>(), channels: {}, joints: {}, body: {}, touching: [] as string[], ...over };
  const keys = new Set(over.keys ?? []);
  const rt: ExpressionRuntime & { t: number; keys: Set<string> } = {
    t: state.t,
    dt: state.dt,
    keys,
    keyDown: (code) => keys.has(code),
    channel: (name) => (state.channels as Record<string, number>)[name] ?? 0,
    jointPosition: (j, d) => (state.joints as Record<string, number>)[d ? `${j}.${d}` : j] ?? 0,
    jointVelocity: () => 0,
    touching: (p) => state.touching.includes(p),
    bodySensor: (name) => (state.body as Record<string, number>)[name] ?? 0,
  };
  return rt;
}

const ev = (src: string, rt = runtime()) => compileExpression(src).evaluate(rt);

describe('expression language', () => {
  it('does arithmetic with the usual precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
    expect(ev('7 % 3')).toBe(1);
    expect(ev('-7 % 3')).toBe(2);
    expect(ev('1 / 0')).toBe(0);
    expect(ev('1.5e1 + .5')).toBe(15.5);
  });

  it('supports logic, comparisons and the ternary operator', () => {
    expect(ev('1 < 2 && 3 >= 3')).toBe(1);
    expect(ev('1 > 2 || 0')).toBe(0);
    expect(ev('!0 + !5')).toBe(1);
    expect(ev('2 == 2 ? 10 : 20')).toBe(10);
    expect(ev('0 ? 1 : 0 ? 2 : 3')).toBe(3);
    expect(ev('true + false')).toBe(1);
  });

  it('knows math functions and constants', () => {
    expect(ev('sin(pi / 2)')).toBeCloseTo(1);
    expect(ev('clamp(5, -1, 1)')).toBe(1);
    expect(ev('max(1, 7, 3)')).toBe(7);
    expect(ev('lerp(0, 10, 0.25)')).toBe(2.5);
    expect(ev('smoothstep(0, 1, 0.5)')).toBeCloseTo(0.5);
    expect(ev('deg(pi)')).toBeCloseTo(180);
    expect(ev('step(0.5, 0.7)')).toBe(1);
  });

  it('reads time, keys, joints, parts, channels and body sensors', () => {
    const rt = runtime({
      t: 2,
      keys: ['KeyW', 'ArrowUp'],
      joints: { knee: 0.4, 'hip.swing': -0.2 },
      channels: { gait: 0.75 },
      body: { roll: 0.1 },
      touching: ['foot'],
    });
    const scope = {
      channels: new Set(['gait']),
      joints: new Map<string, string[]>([['knee', ['bend']], ['hip', ['bend', 'swing']]]),
      parts: new Set(['foot']),
    };
    const e = (src: string) => compileExpression(src, scope).evaluate(rt);
    expect(e('t * 2')).toBe(4);
    expect(e('key("w") + key("s")')).toBe(1);
    expect(e('axis("up", "down")')).toBe(1);
    expect(e('angle("knee") + angle("hip.swing")')).toBeCloseTo(0.2);
    expect(e('gait + ch("gait")')).toBe(1.5);
    expect(e('roll * 10')).toBeCloseTo(1);
    expect(e('touching("foot")')).toBe(1);
  });

  it('checks names against the robot', () => {
    const scope = { channels: new Set(['gait']), joints: new Map<string, string[]>([['hip', ['bend', 'swing']]]), parts: new Set(['foot']) };
    expect(checkExpression('angle("hip.swing")', scope)).toBeNull();
    expect(checkExpression('angle("hip")', scope)).toMatch(/has 2 DOFs/);
    expect(checkExpression('angle("hip.twist")', scope)).toMatch(/no "twist"/);
    expect(checkExpression('touching("paw")', scope)).toMatch(/Unknown part "paw"/);
    expect(checkExpression('gaiter * 2', scope)).toMatch(/Unknown variable "gaiter"/);
  });

  it('reports syntax errors with a position', () => {
    expect(checkExpression('1 +')).toMatch(/at character 4/);
    expect(checkExpression('sin(1, 2)')).toMatch(/takes 1 argument/);
    expect(checkExpression('key(w)')).toMatch(/Unknown variable "w"/);
    expect(checkExpression('key(1)')).toMatch(/expects text/);
    expect(checkExpression('"text"')).toMatch(/only allowed as a function argument/);
    expect(checkExpression('1 # 2')).toMatch(/Unexpected character "#"/);
    expect(checkExpression('')).toMatch(/Empty/);
    expect(checkExpression('wobble(1)')).toMatch(/Unknown function "wobble"/);
  });

  it('keeps state for toggle, smooth and hold', () => {
    const rt = runtime({ dt: 0.1 });
    const toggle = compileExpression('toggle("space")');
    expect(toggle.evaluate(rt)).toBe(0);
    rt.keys.add('Space');
    expect(toggle.evaluate(rt)).toBe(1);
    expect(toggle.evaluate(rt)).toBe(1); // still held: no second flip
    rt.keys.delete('Space');
    expect(toggle.evaluate(rt)).toBe(1);
    rt.keys.add('Space');
    expect(toggle.evaluate(rt)).toBe(0);

    const smooth = compileExpression('smooth(key("w"), 0.5)');
    rt.keys.delete('Space');
    expect(smooth.evaluate(rt)).toBe(0);
    rt.keys.add('KeyW');
    const first = smooth.evaluate(rt);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    for (let i = 0; i < 100; i++) smooth.evaluate(rt);
    expect(smooth.evaluate(rt)).toBeCloseTo(1, 5);

    const hold = compileExpression('hold(t, key("w"))');
    rt.t = 3;
    expect(hold.evaluate(rt)).toBe(3);
    rt.keys.delete('KeyW');
    rt.t = 5;
    expect(hold.evaluate(rt)).toBe(3);
  });

  it('normalises friendly key names', () => {
    expect(normalizeKey('w')).toBe('KeyW');
    expect(normalizeKey('W')).toBe('KeyW');
    expect(normalizeKey('7')).toBe('Digit7');
    expect(normalizeKey('up')).toBe('ArrowUp');
    expect(normalizeKey('Space')).toBe('Space');
    expect(normalizeKey('KeyQ')).toBe('KeyQ');
  });
});

describe('signals', () => {
  it('produces the expected wave shapes', () => {
    const at = (u: number) => Object.fromEntries(Object.entries(WAVES).map(([k, f]) => [k, f(u)]));
    expect(at(0)).toMatchObject({ sine: 0, square: 1, triangle: 0, saw: 0, pulse: 0 });
    expect(at(0.25).sine).toBeCloseTo(1);
    expect(at(0.25).triangle).toBeCloseTo(1);
    expect(at(0.25).pulse).toBeCloseTo(1);
    expect(at(0.75).sine).toBeCloseTo(-1);
    expect(at(0.75).triangle).toBeCloseTo(-1);
    expect(at(0.75).pulse).toBe(0);
    expect(at(0.75).square).toBe(-1);
    expect(at(0.49).saw).toBeCloseTo(0.98);
  });

  it('evaluates waves with amplitude, frequency, phase and offset', () => {
    const s = compileSignal({ kind: 'wave', shape: 'sine', amplitude: 2, frequency: 0.5, phase: 0.25, offset: 1 });
    const rt = runtime({ t: 0 });
    expect(s.evaluate(rt)).toBeCloseTo(3); // phase 0.25 → sin = 1
    rt.t = 1; // half a period later
    expect(s.evaluate(rt)).toBeCloseTo(-1);
  });

  it('maps keys to values, optionally slew-limited', () => {
    const rt = runtime({ dt: 0.1 });
    const instant = compileSignal({ kind: 'keys', positive: 'a', negative: 'd', amount: 2, rest: 1 });
    expect(instant.evaluate(rt)).toBe(1);
    rt.keys.add('KeyA');
    expect(instant.evaluate(rt)).toBe(3);
    rt.keys.add('KeyD');
    expect(instant.evaluate(rt)).toBe(1);

    const slow = compileSignal({ kind: 'keys', positive: 'a', amount: 1, rate: 2 });
    rt.keys.clear();
    rt.keys.add('KeyA');
    expect(slow.evaluate(rt)).toBeCloseTo(0.2);
    expect(slow.evaluate(rt)).toBeCloseTo(0.4);
  });

  it('reads channels with gain and offset and reports what it depends on', () => {
    const s = compileSignal({ kind: 'channel', name: 'gait', gain: -2, offset: 0.5 }, { channels: new Set(['gait']) });
    expect([...s.channels]).toEqual(['gait']);
    expect(s.evaluate(runtime({ channels: { gait: 1 } }))).toBe(-1.5);
    expect(signalError({ kind: 'channel', name: 'nope' }, { channels: new Set(['gait']) })).toMatch(/Unknown channel/);
  });

  it('describes signals for the UI', () => {
    expect(describeSignal({ kind: 'wave', shape: 'sine', amplitude: 0.3, frequency: 1.5, phase: 0.5 })).toBe('sine ±0.3 @ 1.5 Hz, phase 0.5');
    expect(describeSignal({ kind: 'keys', positive: 'up', negative: 'down', amount: 8 })).toBe('keys up/down → 8');
    expect(describeSignal({ kind: 'constant', value: 0.25 })).toBe('constant 0.25');
  });
});
