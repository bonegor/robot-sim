/**
 * Tiny DOM helpers: enough to build the panels without a framework.
 */

type Child = Node | string | number | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'children'>> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  on?: { [E in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[E]) => void };
  attrs?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, style, dataset, on, attrs, ...rest } = props;
  if (cls) el.className = cls;
  if (style) Object.assign(el.style, style);
  if (dataset) Object.assign(el.dataset, dataset);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  Object.assign(el, rest);
  if (on) for (const [ev, fn] of Object.entries(on)) el.addEventListener(ev, fn as EventListener);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

export const clear = (el: HTMLElement): void => el.replaceChildren();

const round = (v: number, step: number): number => {
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))));
  return Number(v.toFixed(decimals));
};

export interface NumberFieldOptions {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  title?: string;
  /** Show a slider next to the number box (needs min and max). */
  slider?: boolean;
  disabled?: boolean;
  /** Called continuously while dragging / typing. */
  onInput?: (value: number) => void;
  /** Called once the edit is finished. */
  onChange: (value: number) => void;
}

/** Label + optional slider + number box, kept in sync. */
export function numberField(o: NumberFieldOptions): HTMLElement {
  const step = o.step ?? 0.01;
  const num = h('input', { type: 'number', step: String(step), value: String(round(o.value, step)), disabled: !!o.disabled });
  if (o.min !== undefined) num.min = String(o.min);
  if (o.max !== undefined) num.max = String(o.max);
  let slider: HTMLInputElement | null = null;
  if (o.slider && o.min !== undefined && o.max !== undefined) {
    slider = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(step), value: String(o.value), disabled: !!o.disabled });
    slider.addEventListener('input', () => {
      num.value = String(round(Number(slider!.value), step));
      o.onInput?.(Number(slider!.value));
    });
    slider.addEventListener('change', () => o.onChange(Number(slider!.value)));
  }
  const read = (): number | null => {
    const v = Number(num.value);
    return num.value.trim() === '' || !Number.isFinite(v) ? null : v;
  };
  num.addEventListener('input', () => {
    const v = read();
    if (v === null) return;
    if (slider) slider.value = String(v);
    o.onInput?.(v);
  });
  num.addEventListener('change', () => {
    const v = read();
    if (v !== null) o.onChange(v);
  });
  return h(
    'label',
    { class: 'field', title: o.title ?? '' },
    h('span', { class: 'field-label' }, o.label),
    h('span', { class: 'field-input' }, slider, num, o.unit ? h('span', { class: 'unit' }, o.unit) : null),
  );
}

export function selectField<T extends string>(label: string, value: T, options: { value: T; label: string; title?: string }[], onChange: (v: T) => void, disabled = false): HTMLElement {
  const sel = h('select', { disabled });
  for (const opt of options) sel.append(h('option', { value: opt.value, selected: opt.value === value, title: opt.title ?? '' }, opt.label));
  sel.addEventListener('change', () => onChange(sel.value as T));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('span', { class: 'field-input' }, sel));
}

export function textField(label: string, value: string, onChange: (v: string) => void, opts: { placeholder?: string; disabled?: boolean } = {}): HTMLElement {
  const input = h('input', { type: 'text', value, placeholder: opts.placeholder ?? '', disabled: !!opts.disabled });
  input.addEventListener('change', () => onChange(input.value));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('span', { class: 'field-input' }, input));
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, opts: { title?: string; disabled?: boolean } = {}): HTMLElement {
  const input = h('input', { type: 'checkbox', checked, disabled: !!opts.disabled });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'field check', title: opts.title ?? '' }, input, h('span', {}, label));
}

/** A row of toggle buttons; exactly one is active. */
export function segmented<T extends string>(
  value: T,
  options: { value: T; label: string; title?: string; color?: string }[],
  onChange: (v: T) => void,
  disabled = false,
): HTMLElement {
  const row = h('div', { class: 'segmented' });
  for (const opt of options) {
    const b = h('button', { type: 'button', textContent: opt.label, title: opt.title ?? '', disabled, class: opt.value === value ? 'active' : '' });
    if (opt.color) b.style.setProperty('--seg-color', opt.color);
    b.addEventListener('click', () => {
      if (opt.value !== value) onChange(opt.value);
    });
    row.append(b);
  }
  return row;
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'panel-section' }, h('h3', {}, title), ...children);
}

export function button(label: string, onClick: () => void, opts: { class?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', { type: 'button', textContent: label, class: opts.class ?? '', title: opts.title ?? '', disabled: !!opts.disabled, on: { click: onClick } });
}

export function swatch(color: string): HTMLElement {
  return h('span', { class: 'swatch', style: { background: color } });
}
