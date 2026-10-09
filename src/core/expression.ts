/**
 * A tiny, safe expression language for joint logic.
 *
 * Examples
 *   0.4 * sin(2*pi*1.5*t)                     — a plain oscillation
 *   key("w") ? 8 : 0                          — drive while W is held
 *   axis("up", "down") * 6 + axis("a","d")*3   — arcade-style mixing
 *   clamp(-2 * roll, -0.5, 0.5)               — balance reflex from a sensor
 *   angle("knee_fl") > 0.5 ? -1 : 1           — logic on another joint
 *   toggle("space") * 0.3 * tri(t)            — switch a pattern on and off
 *
 * Grammar (lowest to highest precedence):
 *   cond ? a : b      ||      &&      == != < <= > >=      + -      * / %      unary - + !      ^ (right assoc.)
 *
 * The source is parsed once into a tree of closures; it never goes near
 * `eval`. Booleans are numbers (true = 1, false = 0).
 */

/** Everything an expression may read while it is evaluated. */
export interface ExpressionRuntime {
  readonly t: number;
  readonly dt: number;
  keyDown(code: string): boolean;
  channel(name: string): number;
  /** Position of a joint DOF (rad or m). `dof` may be omitted for single-DOF joints. */
  jointPosition(joint: string, dof?: string): number;
  jointVelocity(joint: string, dof?: string): number;
  /** Is this part touching anything that is not part of the robot? */
  touching(part: string): boolean;
  /** Root-body sensors: roll, pitch, yaw, height, x, z, vx, vy, vz, speed, forward. */
  bodySensor(name: BodySensorName): number;
}

export const BODY_SENSORS = ['roll', 'pitch', 'yaw', 'height', 'x', 'z', 'vx', 'vy', 'vz', 'speed', 'forward'] as const;
export type BodySensorName = (typeof BODY_SENSORS)[number];

/** Names the compiler accepts for string arguments; anything else is an error. */
export interface ExpressionScope {
  channels?: ReadonlySet<string>;
  /** joint id → DOF names */
  joints?: ReadonlyMap<string, readonly string[]>;
  parts?: ReadonlySet<string>;
}

export interface CompiledExpression {
  readonly source: string;
  /** Channel names this expression reads (for dependency ordering). */
  readonly channels: ReadonlySet<string>;
  evaluate(rt: ExpressionRuntime): number;
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEY_ALIASES: Record<string, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  space: 'Space',
  enter: 'Enter',
  shift: 'ShiftLeft',
  ctrl: 'ControlLeft',
  alt: 'AltLeft',
  tab: 'Tab',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
};

/**
 * Normalises friendly key names to `KeyboardEvent.code` values:
 * "w" → "KeyW", "7" → "Digit7", "up" → "ArrowUp", "KeyW" stays "KeyW".
 */
export function normalizeKey(name: string): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^[a-z]$/i.test(trimmed)) return `Key${trimmed.toUpperCase()}`;
  if (/^[0-9]$/.test(trimmed)) return `Digit${trimmed}`;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Waves (phase measured in cycles: 0..1 is one period)
// ---------------------------------------------------------------------------

export const fract = (x: number): number => x - Math.floor(x);

export const WAVES = {
  sine: (u: number) => Math.sin(2 * Math.PI * u),
  square: (u: number) => (fract(u) < 0.5 ? 1 : -1),
  triangle: (u: number) => 1 - 4 * Math.abs(fract(u + 0.25) - 0.5),
  saw: (u: number) => 2 * fract(u + 0.5) - 1,
  /** Half-wave rectified sine: a smooth bump in the first half of each cycle, zero in the second. */
  pulse: (u: number) => Math.max(0, Math.sin(2 * Math.PI * u)),
} as const;

export type WaveShape = keyof typeof WAVES;
export const WAVE_SHAPES = Object.keys(WAVES) as WaveShape[];

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { type: 'num'; value: number; pos: number }
  | { type: 'str'; value: string; pos: number }
  | { type: 'id'; value: string; pos: number }
  | { type: 'op'; value: string; pos: number }
  | { type: 'eof'; pos: number };

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '^', '<', '>', '!', '?', ':', '(', ')', ','];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExpressionError(`Bad number`, i);
      out.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ type: 'id', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExpressionError('Unterminated string', i);
      out.push({ type: 'str', value: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected character "${c}"`, i);
    out.push({ type: 'op', value: op, pos: i });
    i += op.length;
  }
  out.push({ type: 'eof', pos: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// Compiler (recursive descent straight to closures)
// ---------------------------------------------------------------------------

type Fn = (rt: ExpressionRuntime) => number;
type Arg = { kind: 'num'; fn: Fn; pos: number } | { kind: 'str'; value: string; pos: number };

const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: 2 * Math.PI, e: Math.E, true: 1, false: 0 };

type PureFn = { arity: [number, number]; fn: (...a: number[]) => number };
const PURE: Record<string, PureFn> = {
  sin: { arity: [1, 1], fn: Math.sin },
  cos: { arity: [1, 1], fn: Math.cos },
  tan: { arity: [1, 1], fn: Math.tan },
  asin: { arity: [1, 1], fn: (x) => Math.asin(Math.max(-1, Math.min(1, x))) },
  acos: { arity: [1, 1], fn: (x) => Math.acos(Math.max(-1, Math.min(1, x))) },
  atan: { arity: [1, 1], fn: Math.atan },
  atan2: { arity: [2, 2], fn: Math.atan2 },
  abs: { arity: [1, 1], fn: Math.abs },
  sign: { arity: [1, 1], fn: Math.sign },
  sqrt: { arity: [1, 1], fn: (x) => Math.sqrt(Math.max(0, x)) },
  pow: { arity: [2, 2], fn: Math.pow },
  exp: { arity: [1, 1], fn: Math.exp },
  log: { arity: [1, 1], fn: Math.log },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  round: { arity: [1, 1], fn: Math.round },
  fract: { arity: [1, 1], fn: fract },
  hypot: { arity: [1, 8], fn: Math.hypot },
  min: { arity: [1, 16], fn: Math.min },
  max: { arity: [1, 16], fn: Math.max },
  mod: { arity: [2, 2], fn: (a, b) => (b === 0 ? 0 : a - b * Math.floor(a / b)) },
  clamp: { arity: [3, 3], fn: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  lerp: { arity: [3, 3], fn: (a, b, k) => a + (b - a) * k },
  step: { arity: [2, 2], fn: (edge, x) => (x >= edge ? 1 : 0) },
  smoothstep: {
    arity: [3, 3],
    fn: (e0, e1, x) => {
      const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-9)));
      return k * k * (3 - 2 * k);
    },
  },
  deg: { arity: [1, 1], fn: (x) => (x * 180) / Math.PI },
  rad: { arity: [1, 1], fn: (x) => (x * Math.PI) / 180 },
  wave: { arity: [1, 1], fn: WAVES.sine },
  square: { arity: [1, 1], fn: WAVES.square },
  tri: { arity: [1, 1], fn: WAVES.triangle },
  saw: { arity: [1, 1], fn: WAVES.saw },
  pulse: { arity: [1, 1], fn: WAVES.pulse },
};

/** Function names grouped for the in-app help. */
export const EXPRESSION_HELP = {
  variables: ['t', 'dt', 'pi', 'tau', ...BODY_SENSORS],
  math: Object.keys(PURE).filter((k) => !['wave', 'square', 'tri', 'saw', 'pulse'].includes(k)),
  waves: ['wave(u)', 'square(u)', 'tri(u)', 'saw(u)', 'pulse(u)'],
  inputs: ['key("w")', 'axis("up","down")', 'toggle("space")'],
  sensors: ['angle("joint")', 'angle("joint.dof")', 'speed("joint")', 'touching("part")', 'ch("channel")'],
  memory: ['smooth(x, seconds)', 'hold(x, condition)', 'integrate(x, min, max)'],
};

class Compiler {
  private toks: Token[];
  private i = 0;
  readonly channels = new Set<string>();

  constructor(
    src: string,
    private readonly scope: ExpressionScope,
  ) {
    this.toks = tokenize(src);
  }

  compile(): Fn {
    if (this.peek().type === 'eof') throw new ExpressionError('Empty expression', 0);
    const fn = this.ternary();
    const t = this.peek();
    if (t.type !== 'eof') throw new ExpressionError(`Unexpected "${this.describe(t)}"`, t.pos);
    return fn;
  }

  private peek(): Token {
    return this.toks[this.i]!;
  }
  private next(): Token {
    return this.toks[this.i++]!;
  }
  private describe(t: Token): string {
    return t.type === 'eof' ? 'end of expression' : String(t.value);
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.value === v;
  }
  private expectOp(v: string): void {
    const t = this.next();
    if (t.type !== 'op' || t.value !== v) throw new ExpressionError(`Expected "${v}" but found "${this.describe(t)}"`, t.pos);
  }

  private ternary(): Fn {
    const cond = this.or();
    if (!this.isOp('?')) return cond;
    this.next();
    const a = this.ternary();
    this.expectOp(':');
    const b = this.ternary();
    return (rt) => (cond(rt) !== 0 ? a(rt) : b(rt));
  }

  private or(): Fn {
    let left = this.and();
    while (this.isOp('||')) {
      this.next();
      const l = left;
      const r = this.and();
      left = (rt) => (l(rt) !== 0 || r(rt) !== 0 ? 1 : 0);
    }
    return left;
  }

  private and(): Fn {
    let left = this.compare();
    while (this.isOp('&&')) {
      this.next();
      const l = left;
      const r = this.compare();
      left = (rt) => (l(rt) !== 0 && r(rt) !== 0 ? 1 : 0);
    }
    return left;
  }

  private compare(): Fn {
    let left = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || !['==', '!=', '<', '<=', '>', '>='].includes(t.value)) return left;
      this.next();
      const l = left;
      const r = this.additive();
      switch (t.value) {
        case '==':
          left = (rt) => (l(rt) === r(rt) ? 1 : 0);
          break;
        case '!=':
          left = (rt) => (l(rt) !== r(rt) ? 1 : 0);
          break;
        case '<':
          left = (rt) => (l(rt) < r(rt) ? 1 : 0);
          break;
        case '<=':
          left = (rt) => (l(rt) <= r(rt) ? 1 : 0);
          break;
        case '>':
          left = (rt) => (l(rt) > r(rt) ? 1 : 0);
          break;
        default:
          left = (rt) => (l(rt) >= r(rt) ? 1 : 0);
      }
    }
  }

  private additive(): Fn {
    let left = this.multiplicative();
    for (;;) {
      if (this.isOp('+')) {
        this.next();
        const l = left;
        const r = this.multiplicative();
        left = (rt) => l(rt) + r(rt);
      } else if (this.isOp('-')) {
        this.next();
        const l = left;
        const r = this.multiplicative();
        left = (rt) => l(rt) - r(rt);
      } else return left;
    }
  }

  private multiplicative(): Fn {
    let left = this.unary();
    for (;;) {
      if (this.isOp('*')) {
        this.next();
        const l = left;
        const r = this.unary();
        left = (rt) => l(rt) * r(rt);
      } else if (this.isOp('/')) {
        this.next();
        const l = left;
        const r = this.unary();
        left = (rt) => {
          const d = r(rt);
          return d === 0 ? 0 : l(rt) / d;
        };
      } else if (this.isOp('%')) {
        this.next();
        const l = left;
        const r = this.unary();
        left = (rt) => PURE.mod!.fn(l(rt), r(rt));
      } else return left;
    }
  }

  private unary(): Fn {
    if (this.isOp('-')) {
      this.next();
      const a = this.unary();
      return (rt) => -a(rt);
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    if (this.isOp('!')) {
      this.next();
      const a = this.unary();
      return (rt) => (a(rt) === 0 ? 1 : 0);
    }
    return this.power();
  }

  private power(): Fn {
    const base = this.primary();
    if (!this.isOp('^')) return base;
    this.next();
    const exp = this.unary();
    return (rt) => Math.pow(base(rt), exp(rt));
  }

  private primary(): Fn {
    const t = this.next();
    if (t.type === 'num') {
      const v = t.value;
      return () => v;
    }
    if (t.type === 'op' && t.value === '(') {
      const inner = this.ternary();
      this.expectOp(')');
      return inner;
    }
    if (t.type === 'str') throw new ExpressionError('Text is only allowed as a function argument, e.g. key("w")', t.pos);
    if (t.type === 'id') {
      if (this.isOp('(')) return this.call(t.value, t.pos);
      return this.variable(t.value, t.pos);
    }
    throw new ExpressionError(`Unexpected "${this.describe(t)}"`, t.pos);
  }

  private variable(name: string, pos: number): Fn {
    if (name in CONSTANTS) {
      const v = CONSTANTS[name]!;
      return () => v;
    }
    if (name === 't' || name === 'time') return (rt) => rt.t;
    if (name === 'dt') return (rt) => rt.dt;
    if ((BODY_SENSORS as readonly string[]).includes(name)) {
      const s = name as BodySensorName;
      return (rt) => rt.bodySensor(s);
    }
    if (this.scope.channels?.has(name)) {
      this.channels.add(name);
      return (rt) => rt.channel(name);
    }
    throw new ExpressionError(`Unknown variable "${name}"`, pos);
  }

  private args(): Arg[] {
    this.expectOp('(');
    const out: Arg[] = [];
    if (this.isOp(')')) {
      this.next();
      return out;
    }
    for (;;) {
      const t = this.peek();
      if (t.type === 'str') {
        this.next();
        out.push({ kind: 'str', value: t.value, pos: t.pos });
      } else {
        out.push({ kind: 'num', fn: this.ternary(), pos: t.pos });
      }
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      this.expectOp(')');
      return out;
    }
  }

  private numArgs(name: string, args: Arg[], pos: number, arity: [number, number]): Fn[] {
    if (args.length < arity[0] || args.length > arity[1]) {
      const want = arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]}–${arity[1]}`;
      throw new ExpressionError(`${name}() takes ${want} argument(s), got ${args.length}`, pos);
    }
    return args.map((a) => {
      if (a.kind !== 'num') throw new ExpressionError(`${name}() expects numbers, not text`, a.pos);
      return a.fn;
    });
  }

  private strArgs(name: string, args: Arg[], pos: number, count: [number, number]): string[] {
    if (args.length < count[0] || args.length > count[1]) {
      throw new ExpressionError(`${name}() takes ${count[0] === count[1] ? count[0] : `${count[0]}–${count[1]}`} text argument(s)`, pos);
    }
    return args.map((a) => {
      if (a.kind !== 'str') throw new ExpressionError(`${name}() expects text in quotes, e.g. ${name}("w")`, a.pos);
      return a.value;
    });
  }

  /** Splits "joint.dof" and checks both names against the scope. */
  private jointRef(ref: string, pos: number): [string, string | undefined] {
    const dot = ref.indexOf('.');
    const joint = dot < 0 ? ref : ref.slice(0, dot);
    const dof = dot < 0 ? undefined : ref.slice(dot + 1);
    const joints = this.scope.joints;
    if (joints) {
      const dofs = joints.get(joint);
      if (!dofs) throw new ExpressionError(`Unknown joint "${joint}"`, pos);
      if (dof !== undefined && !dofs.includes(dof)) {
        throw new ExpressionError(`Joint "${joint}" has no "${dof}" (it has: ${dofs.join(', ') || 'none'})`, pos);
      }
      if (dof === undefined && dofs.length !== 1) {
        throw new ExpressionError(`Joint "${joint}" has ${dofs.length} DOFs; name one, e.g. "${joint}.${dofs[0] ?? 'bend'}"`, pos);
      }
    }
    return [joint, dof];
  }

  private call(name: string, pos: number): Fn {
    const args = this.args();
    const pure = PURE[name];
    if (pure) {
      const fns = this.numArgs(name, args, pos, pure.arity);
      const f = pure.fn;
      if (fns.length === 1) {
        const a = fns[0]!;
        return (rt) => f(a(rt));
      }
      if (fns.length === 2) {
        const [a, b] = fns as [Fn, Fn];
        return (rt) => f(a(rt), b(rt));
      }
      return (rt) => f(...fns.map((g) => g(rt)));
    }
    switch (name) {
      case 'key':
      case 'pressed': {
        const [k] = this.strArgs(name, args, pos, [1, 1]);
        const code = normalizeKey(k!);
        return (rt) => (rt.keyDown(code) ? 1 : 0);
      }
      case 'axis': {
        const [p, n] = this.strArgs(name, args, pos, [2, 2]).map(normalizeKey) as [string, string];
        return (rt) => (rt.keyDown(p) ? 1 : 0) - (rt.keyDown(n) ? 1 : 0);
      }
      case 'toggle': {
        // Flips between 0 and 1 every time the key goes down.
        const [k] = this.strArgs(name, args, pos, [1, 1]);
        const code = normalizeKey(k!);
        let state = 0;
        let wasDown = false;
        return (rt) => {
          const down = rt.keyDown(code);
          if (down && !wasDown) state = 1 - state;
          wasDown = down;
          return state;
        };
      }
      case 'angle':
      case 'position': {
        const [ref] = this.strArgs(name, args, pos, [1, 1]);
        const [joint, dof] = this.jointRef(ref!, pos);
        return (rt) => rt.jointPosition(joint, dof);
      }
      case 'speed':
      case 'velocity': {
        const [ref] = this.strArgs(name, args, pos, [1, 1]);
        const [joint, dof] = this.jointRef(ref!, pos);
        return (rt) => rt.jointVelocity(joint, dof);
      }
      case 'touching': {
        const [part] = this.strArgs(name, args, pos, [1, 1]);
        if (this.scope.parts && !this.scope.parts.has(part!)) throw new ExpressionError(`Unknown part "${part}"`, pos);
        return (rt) => (rt.touching(part!) ? 1 : 0);
      }
      case 'ch':
      case 'channel': {
        const [ch] = this.strArgs(name, args, pos, [1, 1]);
        if (this.scope.channels && !this.scope.channels.has(ch!)) throw new ExpressionError(`Unknown channel "${ch}"`, pos);
        this.channels.add(ch!);
        return (rt) => rt.channel(ch!);
      }
      case 'smooth': {
        // First-order low-pass filter with the given time constant (seconds).
        const [x, tau] = this.numArgs(name, args, pos, [2, 2]) as [Fn, Fn];
        let y: number | undefined;
        return (rt) => {
          const v = x(rt);
          if (y === undefined) y = v;
          const k = Math.max(1e-6, tau(rt));
          y += (v - y) * Math.min(1, rt.dt / k);
          return y;
        };
      }
      case 'integrate': {
        // Running total of x·dt (e.g. a speed becomes a position), kept within [lo, hi].
        const fns = this.numArgs(name, args, pos, [1, 3]);
        const [x, lo, hi] = fns as [Fn, Fn | undefined, Fn | undefined];
        let total = 0;
        return (rt) => {
          total += x(rt) * rt.dt;
          if (lo) total = Math.max(lo(rt), total);
          if (hi) total = Math.min(hi(rt), total);
          return total;
        };
      }
      case 'hold': {
        // Tracks x while the condition is true; otherwise keeps the last value
        // (starting from x's first value, like smooth).
        const [x, cond] = this.numArgs(name, args, pos, [2, 2]) as [Fn, Fn];
        let held: number | undefined;
        return (rt) => {
          if (held === undefined || cond(rt) !== 0) held = x(rt);
          return held;
        };
      }
      default:
        throw new ExpressionError(`Unknown function "${name}"`, pos);
    }
  }
}

export function compileExpression(source: string, scope: ExpressionScope = {}): CompiledExpression {
  const c = new Compiler(source, scope);
  const fn = c.compile();
  return {
    source,
    channels: c.channels,
    evaluate(rt) {
      const v = fn(rt);
      return Number.isFinite(v) ? v : 0;
    },
  };
}

/** Returns an error message for an invalid expression, or `null` when it compiles. */
export function checkExpression(source: string, scope: ExpressionScope = {}): string | null {
  try {
    compileExpression(source, scope);
    return null;
  } catch (e) {
    if (e instanceof ExpressionError) return `${e.message} (at character ${e.position + 1})`;
    throw e;
  }
}

/** Names that cannot be used for channels because the language already uses them. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(CONSTANTS),
  't',
  'time',
  'dt',
  ...BODY_SENSORS,
  ...Object.keys(PURE),
  'key',
  'pressed',
  'axis',
  'toggle',
  'angle',
  'position',
  'speed',
  'velocity',
  'touching',
  'ch',
  'channel',
  'smooth',
  'hold',
  'integrate',
]);
