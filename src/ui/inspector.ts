/**
 * The right-hand panel: edits the selected part, the joint it hangs off and
 * the drive of every degree of freedom — or, with nothing selected, the
 * robot as a whole (channels, joint overview, problems).
 */
import type { Assembly } from '../core/assembly';
import { type Blueprint, type ValidationResult, blueprintScope, usedSnaps } from '../core/blueprint';
import { DRIVE_MODES, type DriveMode, isDriven, resolveDrive } from '../core/drives';
import { changeJointType, jointSpec, parentJointOf, partSpec, removePart, setChannel, setDriveMode, setPartSize, setSignal, updateDof, updateDrive, updateJoint, updatePart } from '../core/edit';
import { RESERVED_NAMES } from '../core/expression';
import { type DofDef, JOINT_TYPE_LIST, type JointType, getJointType } from '../core/joints';
import { deg, rad } from '../core/math';
import { getPartType, getSnaps, resolveSize, shapeVolume } from '../core/parts';
import { type SignalKind, type SignalSpec, describeSignal } from '../core/signals';
import type { Robot } from '../physics/simulation';
import { DRIVE_COLORS } from '../render/RobotView';
import { button, checkbox, clear, h, numberField, section, segmented, selectField, textField } from './dom';
import type { Scope } from './scope';
import { type UnitInfo, signalEditor } from './signalEditor';

export interface InspectorContext {
  /** The blueprint this panel was drawn from. */
  bp: Blueprint;
  /** The latest blueprint — edits must start from this, not from `bp`. */
  current(): Blueprint;
  mode: 'build' | 'sim';
  assembly: Assembly | null;
  validation: ValidationResult;
  selectedPart: string | null;
  robot: Robot | null;
  scope: Scope;
  scopeKey: string | null;
  /** Saves an edit. `rerender` rebuilds this panel (needed when its layout changes). */
  commit(bp: Blueprint, opts?: { rerender?: boolean; coalesce?: string }): void;
  /** Shows an edit without recording it (while a slider is dragged). */
  preview(bp: Blueprint): void;
  selectPart(id: string | null): void;
  setScopeKey(key: string | null): void;
}

const ANGLE: UnitInfo = { scale: 180 / Math.PI, unit: '°', range: 180, step: 1 };
const LENGTH: UnitInfo = { scale: 100, unit: 'cm', range: 30, step: 0.5 };

export function positionUnits(def: Pick<DofDef, 'kind'>): UnitInfo {
  return def.kind === 'angular' ? ANGLE : LENGTH;
}

export function signalUnits(def: Pick<DofDef, 'kind'>, mode: DriveMode): UnitInfo {
  if (mode === 'motor') {
    return def.kind === 'angular' ? { scale: 1, unit: 'rad/s', range: 40, step: 0.1 } : { scale: 100, unit: 'cm/s', range: 100, step: 1 };
  }
  return positionUnits(def);
}

function defaultSignalFor(def: DofDef, mode: DriveMode, channels: string[]): (kind: SignalKind) => SignalSpec {
  const ang = def.kind === 'angular';
  const motor = mode === 'motor';
  const big = motor ? (ang ? 6 : 0.2) : ang ? 0.5 : 0.05;
  return (kind) => {
    switch (kind) {
      case 'constant':
        return { kind, value: motor ? big : 0 };
      case 'wave':
        return { kind, shape: 'sine', amplitude: big, frequency: 1, phase: 0, offset: motor ? 0 : ang ? 0 : big };
      case 'keys':
        return { kind, positive: 'up', negative: 'down', amount: big, rest: 0 };
      case 'expression':
        return { kind, expr: motor ? `${big} * axis("up", "down")` : `${big} * sin(2 * pi * t)` };
      case 'channel':
        return { kind, name: channels[0] ?? 'gait', gain: big, offset: 0 };
    }
  };
}

/** The signal a DOF follows in `bp`, if it is driven. */
function latestSignal(bp: Blueprint, jointId: string, dof: string): SignalSpec | undefined {
  const drive = bp.joints.find((j) => j.id === jointId)?.dofs?.[dof]?.drive;
  return drive && 'signal' in drive ? drive.signal : undefined;
}

/** A DOF's range in `bp` (null = unlimited). */
function latestLimits(bp: Blueprint, jointId: string, def: DofDef): [number, number] | null {
  const spec = bp.joints.find((j) => j.id === jointId)?.dofs?.[def.name];
  return spec?.limits === undefined ? def.limits : spec.limits;
}

/** Does the signal editor need to be redrawn (its fields depend on these)? */
const layoutChanged = (a: SignalSpec, b: SignalSpec): boolean =>
  a.kind !== b.kind || (a.kind === 'keys' && b.kind === 'keys' && !!a.hold !== !!b.hold);

const fmt = (v: number, u: UnitInfo) => `${(v * u.scale).toFixed(u.unit === '°' ? 0 : 2)}${u.unit === '°' ? '°' : ` ${u.unit}`}`;

/** Live read-out for one DOF while simulating. */
function liveLine(ctx: InspectorContext, key: string, def: DofDef): HTMLElement | null {
  const s = ctx.robot?.dofs.get(key);
  if (!s) return null;
  const u = positionUnits(def);
  const el = h('div', { class: 'live', dataset: { live: key } });
  el.textContent = `now ${fmt(s.position, u)}`;
  return el;
}

function dofCard(ctx: InspectorContext, jointId: string, def: DofDef): HTMLElement {
  const bp = ctx.bp;
  const joint = jointSpec(bp, jointId);
  const jdef = getJointType(joint.type);
  const spec = joint.dofs?.[def.name] ?? {};
  const drive = resolveDrive(spec.drive, def, jdef.defaultDrive);
  const sim = ctx.mode === 'sim';
  const key = `${jointId}.${def.name}`;
  const units = positionUnits(def);
  const card = h('div', { class: 'dof-card', style: { borderLeftColor: DRIVE_COLORS[drive.mode] } });

  const title = h('div', { class: 'dof-title' }, h('b', {}, def.name), h('span', { class: 'muted' }, ` ${def.label}`));
  card.append(title);
  const live = liveLine(ctx, key, def);
  if (live) card.append(live);

  card.append(
    segmented<DriveMode>(
      drive.mode,
      DRIVE_MODES.map((m) => ({ value: m.mode, label: m.label, title: m.hint, color: DRIVE_COLORS[m.mode] })),
      (mode) => ctx.commit(setDriveMode(ctx.current(), jointId, def.name, mode), { rerender: true }),
    ),
    h('p', { class: 'hint' }, DRIVE_MODES.find((m) => m.mode === drive.mode)!.hint),
  );

  const torque = def.kind === 'angular' ? 'N·m' : 'N';
  const editDrive = (patch: Record<string, unknown>, coalesce: string) => ctx.commit(updateDrive(ctx.current(), jointId, def.name, patch), { coalesce });
  switch (drive.mode) {
    case 'free':
      card.append(
        numberField({ label: 'Friction', value: drive.friction, min: 0, max: def.kind === 'angular' ? 0.2 : 5, step: 0.001, unit: `${torque}·s`, slider: true, title: 'Resistance to motion (viscous damping)', onChange: (v) => editDrive({ friction: v }, `${key}.friction`) }),
      );
      break;
    case 'spring':
      card.append(
        numberField({ label: 'Stiffness', value: drive.stiffness, min: 0, max: def.kind === 'angular' ? 100 : 5000, step: 0.05, unit: def.kind === 'angular' ? 'N·m/rad' : 'N/m', slider: true, onChange: (v) => editDrive({ stiffness: v }, `${key}.k`) }),
        numberField({ label: 'Damping', value: drive.damping, min: 0, max: def.kind === 'angular' ? 5 : 200, step: 0.005, unit: `${torque}·s`, slider: true, onChange: (v) => editDrive({ damping: v }, `${key}.c`) }),
        numberField({ label: 'Rest at', value: drive.rest * units.scale, min: -units.range, max: units.range, step: units.step, unit: units.unit, slider: true, onChange: (v) => editDrive({ rest: v / units.scale }, `${key}.rest`) }),
      );
      break;
    case 'servo':
    case 'motor': {
      const channels = Object.keys(bp.channels ?? {});
      const sunits = signalUnits(def, drive.mode);
      card.append(
        h('div', { class: 'sub' }, drive.mode === 'servo' ? 'Target position comes from:' : 'Target speed comes from:'),
        signalEditor({
          signal: drive.signal!,
          units: sunits,
          channels,
          scope: blueprintScope(bp),
          defaults: defaultSignalFor(def, drive.mode, channels),
          onChange: (update, final) => {
            const latest = ctx.current();
            const was = latestSignal(latest, jointId, def.name) ?? drive.signal!;
            const signal = update(was);
            const next = setSignal(latest, jointId, def.name, signal);
            if (final) ctx.commit(next, { rerender: layoutChanged(was, signal), coalesce: `${key}.signal` });
            else ctx.preview(next);
          },
        }),
      );
      const strength = h('details', { class: 'tuning' }, h('summary', {}, 'Strength & response'));
      if (drive.mode === 'servo') {
        strength.append(
          numberField({ label: 'Stiffness', value: drive.stiffness, min: 0, max: def.kind === 'angular' ? 2000 : 20000, step: 1, unit: def.kind === 'angular' ? 'N·m/rad' : 'N/m', slider: true, onChange: (v) => editDrive({ stiffness: v }, `${key}.k`) }),
          numberField({ label: 'Damping', value: drive.damping, min: 0, max: def.kind === 'angular' ? 50 : 500, step: 0.1, unit: `${torque}·s`, slider: true, onChange: (v) => editDrive({ damping: v }, `${key}.c`) }),
        );
      } else {
        strength.append(numberField({ label: 'Gain', value: drive.gain, min: 0, max: def.kind === 'angular' ? 50 : 500, step: 0.1, unit: `${torque}·s`, slider: true, onChange: (v) => editDrive({ gain: v }, `${key}.gain`) }));
      }
      strength.append(
        numberField({ label: 'Max force', value: drive.maxForce, min: 0, max: def.kind === 'angular' ? 100 : 2000, step: 0.1, unit: torque, slider: true, title: 'The strongest push the actuator can give', onChange: (v) => editDrive({ maxForce: v }, `${key}.max`) }),
      );
      card.append(strength);
      break;
    }
  }

  // Range and starting position.
  const limits = spec.limits === undefined ? def.limits : spec.limits;
  const range = h('details', { class: 'tuning' }, h('summary', {}, limits ? `Range ${fmt(limits[0], units)} … ${fmt(limits[1], units)}` : 'Range: unlimited'));
  range.append(
    checkbox('Limited range', !!limits, (on) => {
      const fallback: [number, number] = def.limits ?? (def.kind === 'angular' ? [-Math.PI / 2, Math.PI / 2] : [-0.1, 0.1]);
      ctx.commit(updateDof(ctx.current(), jointId, def.name, { limits: on ? fallback : null }), { rerender: true });
    }),
  );
  if (limits) {
    const max = def.kind === 'angular' ? 180 : 50;
    range.append(
      numberField({
        label: 'Min',
        value: limits[0] * units.scale,
        min: -max,
        max,
        step: units.step,
        unit: units.unit,
        slider: true,
        onChange: (v) => {
          const [, hi] = latestLimits(ctx.current(), jointId, def) ?? limits;
          ctx.commit(updateDof(ctx.current(), jointId, def.name, { limits: [Math.min(v / units.scale, hi), hi] }), { coalesce: `${key}.lo`, rerender: true });
        },
      }),
      numberField({
        label: 'Max',
        value: limits[1] * units.scale,
        min: -max,
        max,
        step: units.step,
        unit: units.unit,
        slider: true,
        onChange: (v) => {
          const [lo] = latestLimits(ctx.current(), jointId, def) ?? limits;
          ctx.commit(updateDof(ctx.current(), jointId, def.name, { limits: [lo, Math.max(v / units.scale, lo)] }), { coalesce: `${key}.hi`, rerender: true });
        },
      }),
    );
  }
  range.append(
    numberField({
      label: 'Start at',
      value: (spec.initial ?? 0) * units.scale,
      min: limits ? limits[0] * units.scale : -units.range,
      max: limits ? limits[1] * units.scale : units.range,
      step: units.step,
      unit: units.unit,
      slider: true,
      disabled: sim,
      title: 'Pose the robot is assembled in',
      onInput: (v) => ctx.preview(updateDof(ctx.current(), jointId, def.name, { initial: v / units.scale })),
      onChange: (v) => ctx.commit(updateDof(ctx.current(), jointId, def.name, { initial: v / units.scale }), { coalesce: `${key}.init` }),
    }),
  );
  card.append(range);

  if (sim) {
    if (ctx.scopeKey === key) {
      card.append(ctx.scope.canvas, h('div', { class: 'legend' }, h('span', { class: 'l-actual' }, '— actual'), h('span', { class: 'l-target' }, '- - target')));
    } else {
      card.append(button('Plot this', () => ctx.setScopeKey(key), { class: 'small' }));
    }
  }
  return card;
}

function partPanel(ctx: InspectorContext, partId: string): HTMLElement[] {
  const bp = ctx.bp;
  const part = partSpec(bp, partId);
  const def = getPartType(part.type);
  const size = resolveSize(part.type, part.size);
  const sim = ctx.mode === 'sim';
  const parentJoint = parentJointOf(bp, partId);
  const isRoot = !parentJoint;
  const out: HTMLElement[] = [];

  const mass = shapeVolume(def.shape(size)) * (part.density ?? def.defaultDensity);
  out.push(
    h(
      'div',
      { class: 'panel-head' },
      h('div', {}, h('h2', {}, def.label), h('div', { class: 'muted' }, `${partId} · ${def.analog}`)),
      h(
        'div',
        { class: 'head-actions' },
        button('Delete', () => {
          if (isRoot) return;
          ctx.commit(removePart(ctx.current(), partId), { rerender: true });
          ctx.selectPart(parentJoint!.parent.part);
        }, { class: 'danger small', disabled: sim || isRoot, title: isRoot ? 'The first part holds everything else; to start over pick "Empty plate" from Examples' : 'Delete this part and everything attached to it' }),
      ),
    ),
  );
  if (sim) out.push(h('p', { class: 'hint' }, 'Simulating: drives and signals update live. Stop to change the build.'));

  const shape = section(
    'Shape',
    ...def.sizeParams.map((p) =>
      numberField({
        label: p.label,
        value: size[p.key]! * 100,
        min: p.min * 100,
        max: p.max * 100,
        step: Math.max(0.1, p.step * 100),
        unit: 'cm',
        slider: true,
        disabled: sim,
        onInput: (v) => ctx.preview(setPartSize(ctx.current(), partId, p.key, v / 100)),
        onChange: (v) => ctx.commit(setPartSize(ctx.current(), partId, p.key, v / 100), { coalesce: `${partId}.${p.key}`, rerender: true }),
      }),
    ),
    numberField({ label: 'Density', value: part.density ?? def.defaultDensity, min: 50, max: 8000, step: 10, unit: 'kg/m³', slider: true, disabled: sim, onChange: (v) => ctx.commit(updatePart(ctx.current(), partId, { density: v }), { coalesce: `${partId}.density`, rerender: true }) }),
    numberField({ label: 'Friction', value: part.friction ?? def.defaultFriction, min: 0, max: 2, step: 0.05, slider: true, disabled: sim, onChange: (v) => ctx.commit(updatePart(ctx.current(), partId, { friction: v }), { coalesce: `${partId}.friction` }) }),
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Colour'),
      h('span', { class: 'field-input' }, h('input', { type: 'color', value: part.color ?? def.defaultColor, disabled: sim, on: { change: (e) => ctx.commit(updatePart(ctx.current(), partId, { color: (e.target as HTMLInputElement).value })) } })),
    ),
    checkbox('Pinned to the world', !!part.pinned, (pinned) => ctx.commit(updatePart(ctx.current(), partId, { pinned: pinned || undefined }), { rerender: true }), { disabled: sim, title: 'Bolt this part in place, like the base of a robot arm' }),
    h('div', { class: 'muted small' }, `Mass ≈ ${mass < 1 ? `${(mass * 1000).toFixed(0)} g` : `${mass.toFixed(2)} kg`}`),
  );
  out.push(shape);

  if (parentJoint) {
    const j = parentJoint;
    const jdef = getJointType(j.type);
    const childSnaps = getSnaps(part.type, size);
    const usedHere = usedSnaps(bp, partId);
    const connection = section(
      'Connection',
      h('p', { class: 'muted small' }, `Joint "${j.id}" · attached to ${j.parent.part} at "${j.parent.snap}"`),
      selectField<JointType>(
        'Joint type',
        j.type,
        JOINT_TYPE_LIST.map((t) => ({ value: t.type, label: `${t.label} — ${t.family === 'natural' ? t.analog.split(',')[0] : 'robotic'}`, title: `${t.analog}. ${t.description}` })),
        (type) => ctx.commit(changeJointType(ctx.current(), j.id, type), { rerender: true }),
        sim,
      ),
      h('p', { class: 'hint' }, `${jdef.analog}. ${jdef.description}`),
      numberField({
        label: 'Turn',
        value: deg(j.angle ?? 0),
        min: -180,
        max: 180,
        step: 15,
        unit: '°',
        slider: true,
        disabled: sim,
        title: 'Rotate the joint (and this part) about the connection axis',
        onInput: (v) => ctx.preview(updateJoint(ctx.current(), j.id, { angle: rad(v) })),
        onChange: (v) => ctx.commit(updateJoint(ctx.current(), j.id, { angle: rad(v) }), { coalesce: `${j.id}.angle` }),
      }),
      selectField(
        'Attached by',
        j.child.snap,
        childSnaps.filter((s) => s.id === j.child.snap || !usedHere.has(s.id)).map((s) => ({ value: s.id, label: s.label })),
        (snap) => ctx.commit(updateJoint(ctx.current(), j.id, { child: { part: partId, snap } }), { rerender: true }),
        sim,
      ),
    );
    out.push(connection);
    if (jdef.dofs.length) {
      const cards = jdef.dofs.map((d) => dofCard(ctx, j.id, d));
      // The physics engine solves several driven rotation axes of one joint
      // together; bent and loaded, they hold far less firmly than a hinge.
      const rotations = jdef.dofs.filter((d) => d.kind === 'angular');
      const driven = rotations.some((d) => isDriven(resolveDrive(j.dofs?.[d.name]?.drive, d, jdef.defaultDrive).mode));
      if (rotations.length > 1 && driven) {
        cards.push(h('p', { class: 'hint' }, 'Tip: servos on a joint with several rotation axes go soft when it is bent and carrying weight. For legs, chain single-axis hinges instead (turn one a quarter turn to swing sideways), like the Dog, Spider and Salamander.'));
      }
      out.push(section(jdef.dofs.length > 1 ? 'Degrees of freedom' : 'Motion', ...cards));
    } else out.push(section('Motion', h('p', { class: 'muted' }, 'A weld has no motion: the two parts act as one.')));
  } else {
    out.push(section('Connection', h('p', { class: 'muted' }, 'This is the root part: everything else hangs off it.')));
  }
  return out;
}

function robotPanel(ctx: InspectorContext): HTMLElement[] {
  const bp = ctx.bp;
  const sim = ctx.mode === 'sim';
  const out: HTMLElement[] = [];
  out.push(h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, bp.name || 'Robot'), h('div', { class: 'muted' }, bp.description ?? 'Click a part to edit it.'))));

  // Overview of every joint and how each DOF is driven.
  const counts: Record<string, number> = { free: 0, spring: 0, servo: 0, motor: 0 };
  const rows = bp.joints.map((j) => {
    const jdef = getJointType(j.type);
    const chips = jdef.dofs.map((d) => {
      const mode = resolveDrive(j.dofs?.[d.name]?.drive, d, jdef.defaultDrive).mode;
      counts[mode]!++;
      const sig = j.dofs?.[d.name]?.drive;
      const title = sig && 'signal' in sig ? `${d.name}: ${mode} ← ${describeSignal(sig.signal)}` : `${d.name}: ${mode}`;
      return h('span', { class: 'chip', title, style: { background: DRIVE_COLORS[mode] } }, d.name);
    });
    return h(
      'button',
      { type: 'button', class: 'joint-row', on: { click: () => ctx.selectPart(j.child.part) } },
      h('span', { class: 'joint-name' }, j.id),
      h('span', { class: 'muted' }, jdef.label),
      h('span', { class: 'chips' }, ...(chips.length ? chips : [h('span', { class: 'chip', style: { background: DRIVE_COLORS.weld } }, 'rigid')])),
    );
  });
  const mass = ctx.assembly ? [...ctx.assembly.parts.values()].reduce((m, p) => m + shapeVolume(p.shape) * p.density, 0) : 0;
  out.push(
    section(
      'Overview',
      h('div', { class: 'stats' }, `${bp.parts.length} parts · ${bp.joints.length} joints · ${mass.toFixed(2)} kg`),
      h(
        'div',
        { class: 'legend-row' },
        ...(['free', 'spring', 'servo', 'motor'] as const).map((m) => h('span', { class: 'chip', style: { background: DRIVE_COLORS[m] } }, `${counts[m]} ${m}`)),
      ),
      h('p', { class: 'hint' }, 'Free and spring joints are passive (they flap and bounce); servo and motor joints follow a signal.'),
      ...rows,
    ),
  );

  // Channels: named signals any joint can share.
  const channelSection = section('Channels');
  channelSection.append(h('p', { class: 'hint' }, 'Named signals shared by the whole robot, e.g. one gait clock for every leg. Use them from a joint (signal: Channel) or in logic by name.'));
  const scope = blueprintScope(bp);
  for (const [name, spec] of Object.entries(bp.channels ?? {})) {
    channelSection.append(
      h(
        'div',
        { class: 'dof-card' },
        h('div', { class: 'dof-title' }, h('b', {}, name), button('Remove', () => ctx.commit(setChannel(ctx.current(), name, null), { rerender: true }), { class: 'small danger' })),
        sim && ctx.robot ? h('div', { class: 'live', dataset: { channel: name } }, '') : null,
        signalEditor({
          signal: spec,
          units: { scale: 1, unit: '', range: 10, step: 0.01 },
          channels: Object.keys(bp.channels ?? {}).filter((c) => c !== name),
          scope,
          defaults: (kind) => defaultSignalFor({ name: 'x', label: '', axis: 'angX', kind: 'angular', limits: null }, 'servo', [])(kind),
          onChange: (update, final) => {
            const latest = ctx.current();
            const was = latest.channels?.[name] ?? spec;
            const signal = update(was);
            const next = setChannel(latest, name, signal);
            if (final) ctx.commit(next, { rerender: layoutChanged(was, signal), coalesce: `ch.${name}` });
            else ctx.preview(next);
          },
        }),
      ),
    );
  }
  const newName = h('input', { type: 'text', placeholder: 'new channel name' });
  const addChannel = () => {
    const name = newName.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_NAMES.has(name) || bp.channels?.[name]) {
      newName.classList.add('bad');
      return;
    }
    ctx.commit(setChannel(ctx.current(), name, { kind: 'wave', shape: 'sine', amplitude: 1, frequency: 1, phase: 0, offset: 0 }), { rerender: true });
  };
  newName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addChannel();
  });
  channelSection.append(h('div', { class: 'add-row' }, newName, button('Add', addChannel, { class: 'small' })));
  out.push(channelSection);

  out.push(
    section(
      'Settings',
      textField('Name', bp.name, (name) => ctx.commit({ ...ctx.current(), name }, { rerender: true })),
      checkbox('Parts collide with each other', bp.selfCollision !== false, (on) => ctx.commit({ ...ctx.current(), selfCollision: on }), { disabled: sim, title: 'Neighbours joined by a joint never collide; this controls all other pairs' }),
    ),
  );

  const { errors, warnings } = ctx.validation;
  if (errors.length || warnings.length) {
    out.push(
      section(
        'Problems',
        ...errors.map((e) => h('div', { class: 'issue error' }, h('b', {}, e.path), ` ${e.message}`)),
        ...warnings.map((w) => h('div', { class: 'issue warning' }, h('b', {}, w.path), ` ${w.message}`)),
      ),
    );
  }
  return out;
}

export function renderInspector(el: HTMLElement, ctx: InspectorContext): void {
  const scrollTop = el.scrollTop;
  const open = new Set([...el.querySelectorAll('details[open] > summary')].map((s) => s.textContent ?? ''));
  clear(el);
  const exists = ctx.selectedPart && ctx.bp.parts.some((p) => p.id === ctx.selectedPart);
  const content = exists ? partPanel(ctx, ctx.selectedPart!) : robotPanel(ctx);
  el.append(...content);
  // Keep <details> the user opened open across re-renders.
  for (const s of el.querySelectorAll('details > summary')) if (open.has(s.textContent ?? '')) (s.parentElement as HTMLDetailsElement).open = true;
  el.scrollTop = scrollTop;
}

/** Refreshes the live read-outs without rebuilding the panel. */
export function updateLiveReadouts(el: HTMLElement, robot: Robot): void {
  for (const node of el.querySelectorAll<HTMLElement>('[data-live]')) {
    const s = robot.dofs.get(node.dataset.live!);
    if (!s) continue;
    const u = positionUnits(s.def);
    let text = `now ${fmt(s.position, u)}`;
    if (s.target !== null) {
      const tu = s.config.drive.mode === 'motor' ? signalUnits(s.def, 'motor') : u;
      text += s.config.drive.mode === 'motor' ? ` · speed ${fmt(s.velocity, tu)} → ${fmt(s.target, tu)}` : ` → target ${fmt(s.target, u)}`;
    }
    node.textContent = text;
  }
  for (const node of el.querySelectorAll<HTMLElement>('[data-channel]')) {
    const v = robot.brain.channelValues().get(node.dataset.channel!);
    node.textContent = v === undefined ? '' : `now ${v.toFixed(3)}`;
  }
}
