/**
 * Editor for a signal: wave, keyboard, logic formula, channel or constant.
 */
import { EXPRESSION_HELP, type ExpressionScope, WAVE_SHAPES, WAVES, type WaveShape, checkExpression } from '../core/expression';
import { SIGNAL_KINDS, type SignalKind, type SignalSpec } from '../core/signals';
import { checkbox, h, numberField, segmented, selectField, textField } from './dom';

/** How raw (SI) values are shown: display = value × scale. */
export interface UnitInfo {
  scale: number;
  unit: string;
  /** Slider range in display units for amplitude-like fields. */
  range: number;
  step: number;
}

export interface SignalEditorOptions {
  signal: SignalSpec;
  units: UnitInfo;
  channels: string[];
  scope: ExpressionScope;
  disabled?: boolean;
  /** Default signal when switching to another kind. */
  defaults: (kind: SignalKind) => SignalSpec;
  /**
   * Receives a function that turns the *latest* signal into the edited one
   * (so consecutive edits never undo each other). `final` is false while a
   * slider is being dragged.
   */
  onChange: (update: (current: SignalSpec) => SignalSpec, final: boolean) => void;
}

function sparkline(spec: Extract<SignalSpec, { kind: 'wave' }>): HTMLCanvasElement {
  const c = h('canvas', { class: 'sparkline', width: 220, height: 40 });
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const fn = WAVES[spec.shape];
  const periods = 2;
  const amp = Math.abs(spec.amplitude) || 1;
  const off = spec.offset ?? 0;
  const lo = Math.min(off - amp, 0);
  const hi = Math.max(off + amp, 0);
  const y = (v: number) => 36 - ((v - lo) / (hi - lo || 1)) * 32;
  ctx.strokeStyle = 'rgba(128,128,128,0.35)';
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(220, y(0));
  ctx.stroke();
  ctx.strokeStyle = '#f77f00';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 220; i++) {
    const u = (i / 220) * periods + (spec.phase ?? 0);
    const v = off + spec.amplitude * fn(u);
    if (i === 0) ctx.moveTo(i, y(v));
    else ctx.lineTo(i, y(v));
  }
  ctx.stroke();
  return c;
}

export function signalEditor(o: SignalEditorOptions): HTMLElement {
  const root = h('div', { class: 'signal-editor' });
  const s = o.signal;
  const { scale, unit, range, step } = o.units;
  const disp = (v: number | undefined) => (v ?? 0) * scale;
  const raw = (v: number) => v / scale;
  // Each field patches whatever the signal is by the time it fires.
  const emit = <S extends SignalSpec>(patch: (cur: S) => SignalSpec, final = true) =>
    o.onChange((cur) => patch((cur.kind === s.kind ? cur : s) as S), final);
  const replace = (next: SignalSpec) => o.onChange(() => next, true);

  root.append(
    segmented<SignalKind>(
      s.kind,
      SIGNAL_KINDS.map((k) => ({ value: k.kind, label: k.label, title: k.hint })),
      (kind) => replace(o.defaults(kind)),
      o.disabled,
    ),
  );

  const body = h('div', { class: 'signal-body' });
  root.append(body);
  const disabled = !!o.disabled;

  switch (s.kind) {
    case 'constant':
      body.append(
        numberField({ label: 'Value', value: disp(s.value), min: -range, max: range, step, unit, slider: true, disabled, onInput: (v) => emit<typeof s>((cur) => ({ ...cur, value: raw(v) }), false), onChange: (v) => emit<typeof s>((cur) => ({ ...cur, value: raw(v) })) }),
      );
      break;
    case 'wave': {
      const preview = sparkline(s);
      body.append(
        selectField<WaveShape>('Shape', s.shape, WAVE_SHAPES.map((w) => ({ value: w, label: w })), (shape) => emit<typeof s>((cur) => ({ ...cur, shape })), disabled),
        numberField({
          label: 'Amplitude',
          value: disp(s.amplitude),
          min: -range,
          max: range,
          step,
          unit,
          slider: true,
          disabled,
          title: 'How far it swings either side of the offset',
          onInput: (v) => emit<typeof s>((cur) => ({ ...cur, amplitude: raw(v) }), false),
          onChange: (v) => emit<typeof s>((cur) => ({ ...cur, amplitude: raw(v) })),
        }),
        numberField({ label: 'Frequency', value: s.frequency, min: 0, max: 5, step: 0.05, unit: 'Hz', slider: true, disabled, onInput: (v) => emit<typeof s>((cur) => ({ ...cur, frequency: v }), false), onChange: (v) => emit<typeof s>((cur) => ({ ...cur, frequency: v })) }),
        numberField({
          label: 'Phase',
          value: s.phase ?? 0,
          min: 0,
          max: 1,
          step: 0.05,
          unit: 'cycle',
          slider: true,
          disabled,
          title: 'Shift in time, as a fraction of one period (0.5 = half a beat later)',
          onInput: (v) => emit<typeof s>((cur) => ({ ...cur, phase: v }), false),
          onChange: (v) => emit<typeof s>((cur) => ({ ...cur, phase: v })),
        }),
        numberField({ label: 'Offset', value: disp(s.offset), min: -range, max: range, step, unit, slider: true, disabled, onInput: (v) => emit<typeof s>((cur) => ({ ...cur, offset: raw(v) }), false), onChange: (v) => emit<typeof s>((cur) => ({ ...cur, offset: raw(v) })) }),
        preview,
      );
      break;
    }
    case 'keys': {
      body.append(
        textField('Key +', s.positive, (v) => emit<typeof s>((cur) => ({ ...cur, positive: v.trim() || 'up' })), { placeholder: 'e.g. w, up, space', disabled }),
        textField('Key −', s.negative ?? '', (v) => {
          emit<typeof s>((cur) => {
            const next = { ...cur };
            if (v.trim()) next.negative = v.trim();
            else delete next.negative;
            return next;
          });
        }, { placeholder: 'optional', disabled }),
        checkbox('Hold position (jog)', !!s.hold, (hold) => emit<typeof s>((cur) => ({ ...cur, hold })), { title: 'Keys move the value at "amount" per second and it stays when released', disabled }),
        numberField({ label: s.hold ? 'Speed' : 'Amount', value: disp(s.amount), min: -range, max: range, step, unit: s.hold ? `${unit}/s` : unit, slider: true, disabled, onChange: (v) => emit<typeof s>((cur) => ({ ...cur, amount: raw(v) })) }),
        numberField({ label: s.hold ? 'Start' : 'Rest', value: disp(s.rest), min: -range, max: range, step, unit, slider: true, disabled, onChange: (v) => emit<typeof s>((cur) => ({ ...cur, rest: raw(v) })) }),
      );
      if (!s.hold) {
        body.append(
          numberField({ label: 'Smoothing', value: disp(s.rate), min: 0, max: range * 4, step, unit: `${unit}/s`, disabled, title: 'Maximum rate of change; 0 = instant', onChange: (v) => emit<typeof s>((cur) => ({ ...cur, rate: raw(v) })) }),
        );
      }
      break;
    }
    case 'expression': {
      const area = h('textarea', { class: 'expr', value: s.expr, rows: 3, spellcheck: false, disabled });
      const msg = h('div', { class: 'expr-msg' });
      const check = () => {
        const err = checkExpression(area.value, o.scope);
        msg.textContent = err ?? '✓ OK';
        msg.className = `expr-msg ${err ? 'bad' : 'good'}`;
        return err;
      };
      check();
      area.addEventListener('input', check);
      area.addEventListener('change', () => {
        if (!check()) emit<typeof s>((cur) => ({ ...cur, expr: area.value }));
      });
      const help = h(
        'details',
        { class: 'expr-help' },
        h('summary', {}, 'What can I write?'),
        h('p', {}, 'Values are in SI units (radians, metres). Booleans are 1/0.'),
        h('p', {}, h('b', {}, 'Variables: '), EXPRESSION_HELP.variables.join(', ')),
        h('p', {}, h('b', {}, 'Waves (u in cycles): '), EXPRESSION_HELP.waves.join(', ')),
        h('p', {}, h('b', {}, 'Keys: '), EXPRESSION_HELP.inputs.join(', ')),
        h('p', {}, h('b', {}, 'Sensors: '), EXPRESSION_HELP.sensors.join(', ')),
        h('p', {}, h('b', {}, 'Memory: '), EXPRESSION_HELP.memory.join(', ')),
        h('p', {}, h('b', {}, 'Math: '), EXPRESSION_HELP.math.join(', ')),
        h('p', {}, h('b', {}, 'Logic: '), 'a < b, a == b, a && b, a || b, !a, cond ? a : b'),
        h('p', { class: 'muted' }, 'Example: key("w") ? 0.4 * sin(2*pi*1.5*t) : 0'),
      );
      body.append(area, msg, help);
      break;
    }
    case 'channel': {
      if (o.channels.length === 0) {
        body.append(h('p', { class: 'muted' }, 'This robot has no channels yet. Click empty space to open the Robot panel and add one.'));
        break;
      }
      const name = o.channels.includes(s.name) ? s.name : o.channels[0]!;
      if (name !== s.name) queueMicrotask(() => emit<typeof s>((cur) => ({ ...cur, name })));
      body.append(
        selectField('Channel', name, o.channels.map((c) => ({ value: c, label: c })), (v) => emit<typeof s>((cur) => ({ ...cur, name: v })), disabled),
        numberField({ label: 'Gain', value: disp(s.gain ?? 1), min: -range, max: range, step, unit: unit ? `${unit} per unit` : '', disabled, onChange: (v) => emit<typeof s>((cur) => ({ ...cur, gain: raw(v) })) }),
        numberField({ label: 'Offset', value: disp(s.offset), min: -range, max: range, step, unit, disabled, onChange: (v) => emit<typeof s>((cur) => ({ ...cur, offset: raw(v) })) }),
      );
      break;
    }
  }
  return root;
}
