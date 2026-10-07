/**
 * The application: owns the blueprint being edited, the 3D view, the
 * simulation and all panels, and routes input between them.
 *
 * Build mode  – the robot is shown snapped together at its spawn pose; blue
 *               dots mark free snap points. Click a dot, pick a joint type,
 *               then click a part to attach it.
 * Simulate    – the blueprint is handed to the physics engine; keys go to
 *               the robot's brain, clicking a part pokes it, and drives /
 *               signals can be tuned live.
 */
import * as THREE from 'three';
import { type Assembly, assemble, assemblyBounds, spawnRootPose } from '../core/assembly';
import { type Blueprint, type ValidationResult, findRoot, keysUsed, parseBlueprint, serializeBlueprint, validateBlueprint } from '../core/blueprint';
import { attachPart, freeSnaps, normalizeBlueprint, oppositeSnap, parentJointOf, removePart, setRoot, updateJoint } from '../core/edit';
import { JOINT_TYPE_LIST, type JointType } from '../core/joints';
import { PART_TYPE_LIST, type PartType, getPartType, getSnaps, resolveSize } from '../core/parts';
import { qrotate, v3 } from '../core/math';
import { PRESETS, presetById } from '../presets';
import { type Robot, Simulation, structureKey } from '../physics/simulation';
import { DRIVE_COLORS, RobotView, type SnapMarkerData } from '../render/RobotView';
import type { Viewport } from '../render/Viewport';
import { button, clear, h } from './dom';
import { renderInspector, signalUnits, positionUnits, updateLiveReadouts } from './inspector';
import { Scope } from './scope';

type Mode = 'build' | 'sim';

interface Elements {
  toolbar: HTMLElement;
  palette: HTMLElement;
  inspector: HTMLElement;
  hud: HTMLElement;
  hint: HTMLElement;
  help: HTMLDialogElement;
}

const STORAGE_KEY = 'robot-sim/blueprint';
const SPEEDS = [0.25, 0.5, 1, 2];

export class App {
  bp: Blueprint;
  mode: Mode = 'build';
  selectedPart: string | null = null;
  selectedSnap: { part: string; snap: string } | null = null;
  jointChoice: JointType = 'hinge';
  validation: ValidationResult = { ok: true, errors: [], warnings: [] };

  private history: Blueprint[] = [];
  private future: Blueprint[] = [];
  private lastCoalesce: { key: string; at: number } | null = null;
  private assembly: Assembly | null = null;
  private view: RobotView | null = null;
  private attachArrow: THREE.Object3D | null = null;
  private sim: Simulation | null = null;
  private robot: Robot | null = null;
  private paused = false;
  private speed = 1;
  private followCamera = true;
  private showJoints = true;
  private accumulator = 0;
  private hudTimer = 0;
  private readonly scope = new Scope();
  private scopeKey: string | null = null;
  private presetId: string | null = null;
  private pointerDown: { x: number; y: number; t: number } | null = null;

  constructor(
    private readonly viewport: Viewport,
    private readonly el: Elements,
  ) {
    const saved = this.restore();
    this.bp = saved ?? presetById('dog')!.build();
    this.presetId = saved ? null : 'dog';
    this.validation = validateBlueprint(this.bp);
    this.rebuildView(true);
    this.renderAll();
    this.bindInput();
    viewport.onFrame((dt) => this.frame(dt));
  }

  // ---------------------------------------------------------------------------
  // Blueprint state
  // ---------------------------------------------------------------------------

  private restore(): Blueprint | null {
    try {
      const json = localStorage.getItem(STORAGE_KEY);
      return json ? parseBlueprint(json) : null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, serializeBlueprint(this.bp));
    } catch {
      // Storage can be unavailable (private mode); saving is best effort.
    }
  }

  /** Records an edit (undoable) and refreshes what depends on it. */
  commit = (bp: Blueprint, opts: { rerender?: boolean; coalesce?: string } = {}): void => {
    const now = performance.now();
    const coalesce = opts.coalesce && this.lastCoalesce?.key === opts.coalesce && now - this.lastCoalesce.at < 1500;
    if (!coalesce) this.history.push(this.bp);
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
    this.apply(bp, opts.rerender ?? false);
  };

  /** Shows an edit without recording it (live slider drags). */
  preview = (bp: Blueprint): void => {
    if (this.mode === 'sim') {
      this.retune(bp);
      return;
    }
    const v = validateBlueprint(bp);
    if (v.ok || v.errors.every((e) => e.path.includes('signal') || e.path.startsWith('channels'))) this.showBlueprint(bp);
  };

  private apply(bp: Blueprint, rerender: boolean): void {
    const structural = structureKey(bp) !== structureKey(this.bp);
    this.bp = bp;
    this.validation = validateBlueprint(bp);
    this.persist();
    if (this.selectedPart && !bp.parts.some((p) => p.id === this.selectedPart)) this.selectedPart = null;
    if (this.selectedSnap && !this.snapIsFree(this.selectedSnap)) this.selectedSnap = null;
    if (this.mode === 'sim') {
      if (structural) void this.startSim();
      else if (this.validation.ok) this.retune(bp);
    } else {
      this.rebuildView(false);
    }
    if (rerender) this.renderInspector();
    this.renderPalette();
    this.renderToolbar();
    this.renderHud();
  }

  /** Live-tunes the running robot; anything invalid is simply not applied. */
  private retune(bp: Blueprint): void {
    try {
      this.robot?.retune(bp);
    } catch {
      // e.g. a half-edited signal: keep running with the previous settings
    }
  }

  private load(bp: Blueprint, presetId: string | null): void {
    this.history.push(this.bp);
    this.future = [];
    this.presetId = presetId;
    this.selectedPart = null;
    this.selectedSnap = null;
    if (this.mode === 'sim') this.stopSim();
    this.bp = normalizeBlueprint(bp);
    this.validation = validateBlueprint(this.bp);
    this.persist();
    this.rebuildView(true);
    this.renderAll();
  }

  undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.bp);
    this.lastCoalesce = null;
    this.apply(prev, true);
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.bp);
    this.lastCoalesce = null;
    this.apply(next, true);
  }

  private snapIsFree(ref: { part: string; snap: string }): boolean {
    if (!this.bp.parts.some((p) => p.id === ref.part)) return false;
    return freeSnaps(this.bp, ref.part).some((s) => s.id === ref.snap);
  }

  // ---------------------------------------------------------------------------
  // 3D view
  // ---------------------------------------------------------------------------

  private showBlueprint(bp: Blueprint, frame = false): void {
    let asm: Assembly;
    try {
      asm = assemble(bp, { trusted: true, rootPose: spawnRootPose(bp) });
    } catch {
      return; // keep showing the last good assembly
    }
    // Keep the camera locked onto the root part: adding legs lifts the whole
    // robot (it is always shown standing on the ground), and the view follows.
    const before = this.assembly?.parts.get(this.assembly.root)?.pose.p;
    const after = asm.parts.get(asm.root)?.pose.p;
    if (!frame && before && after && this.assembly?.root === asm.root) {
      const shift = new THREE.Vector3(after.x - before.x, after.y - before.y, after.z - before.z);
      this.viewport.controls.target.add(shift);
      this.viewport.camera.position.add(shift);
    }
    this.view?.dispose();
    this.assembly = asm;
    this.view = new RobotView(asm, { snaps: this.mode === 'build', joints: true });
    this.view.setJointsVisible(this.showJoints);
    this.viewport.scene.add(this.view.group);
    this.view.setSelectedPart(this.selectedPart);
    this.view.setSelectedSnap(this.selectedSnap?.part ?? null, this.selectedSnap?.snap ?? null);
    this.updateAttachArrow();
    if (frame) {
      const b = assemblyBounds(asm);
      this.viewport.frameBox(b.min, b.max);
    }
  }

  private rebuildView(frame: boolean): void {
    this.showBlueprint(this.bp, frame);
  }

  private updateAttachArrow(): void {
    this.attachArrow?.removeFromParent();
    this.attachArrow = null;
    if (this.mode !== 'build' || !this.selectedSnap || !this.view) return;
    const pose = this.view.snapWorldPose(this.selectedSnap.part, this.selectedSnap.snap);
    if (!pose) return;
    const dir = qrotate(pose.q, v3(0, 0, 1));
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(dir.x, dir.y, dir.z), new THREE.Vector3(pose.p.x, pose.p.y, pose.p.z), 0.09, 0xffd60a, 0.03, 0.02);
    arrow.traverse((o) => {
      if ((o as THREE.Mesh).material) {
        const m = (o as THREE.Mesh).material as THREE.Material;
        m.depthTest = false;
      }
      o.renderOrder = 11;
    });
    this.viewport.overlay.add(arrow);
    this.attachArrow = arrow;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  async startSim(): Promise<void> {
    this.validation = validateBlueprint(this.bp);
    if (!this.validation.ok) {
      this.flash(`Fix ${this.validation.errors.length} problem(s) before simulating — see the Robot panel.`);
      this.selectedPart = null;
      this.renderInspector();
      return;
    }
    // Build the new world before throwing the old one away, so a frame can never
    // step a disposed simulation.
    let sim: Simulation;
    let robot: Robot;
    try {
      sim = await Simulation.create();
      robot = sim.addRobot(this.bp);
    } catch (e) {
      this.flash(`Could not start the simulation: ${(e as Error).message}`);
      return;
    }
    this.sim?.dispose();
    this.sim = sim;
    this.robot = robot;
    this.mode = 'sim';
    this.paused = false;
    this.accumulator = 0;
    this.selectedSnap = null;
    this.scope.reset();
    if (!this.scopeKey || !robot.dofs.has(this.scopeKey)) this.scopeKey = this.defaultScopeKey();
    this.view?.dispose();
    this.view = new RobotView(robot.assembly, { snaps: false, joints: true });
    this.view.setJointsVisible(this.showJoints);
    this.view.setSelectedPart(this.selectedPart);
    this.viewport.scene.add(this.view.group);
    this.updateAttachArrow();
    for (const note of robot.notes) this.flash(note);
    this.renderAll();
  }

  stopSim(): void {
    // Bring the camera back to where the robot is shown while building.
    const where = this.robot?.rootPose().p;
    const home = this.assembly?.parts.get(this.assembly.root)?.pose.p;
    if (where && home) {
      const shift = new THREE.Vector3(home.x - where.x, home.y - where.y, home.z - where.z);
      this.viewport.controls.target.add(shift);
      this.viewport.camera.position.add(shift);
    }
    this.mode = 'build';
    this.sim?.dispose();
    this.sim = null;
    this.robot = null;
    this.viewport.follow(null);
    this.rebuildView(false);
    this.renderAll();
  }

  private defaultScopeKey(): string | null {
    const robot = this.robot;
    if (!robot) return null;
    const joint = this.selectedPart ? parentJointOf(this.bp, this.selectedPart) : undefined;
    const candidates = joint ? [...robot.dofs.values()].filter((d) => d.joint === joint.id) : [...robot.dofs.values()];
    return (candidates.find((d) => d.config.drive.mode === 'servo' || d.config.drive.mode === 'motor') ?? candidates[0])?.key ?? null;
  }

  private frame(dt: number): void {
    if (this.mode !== 'sim' || !this.sim || !this.robot || !this.view) return;
    if (!this.paused) {
      this.accumulator += dt * this.speed;
      const step = this.sim.timestep;
      let n = 0;
      while (this.accumulator >= step && n < 40) {
        this.sim.step();
        this.accumulator -= step;
        n++;
        if (this.scopeKey) {
          const s = this.robot.dofs.get(this.scopeKey);
          if (s && n % 4 === 0) this.scope.push(this.sim.time, s.config.drive.mode === 'motor' ? s.velocity : s.position, s.target);
        }
      }
      if (n === 40) this.accumulator = 0; // too slow to keep up: drop time rather than spiral
    }
    this.view.syncFromRobot(this.robot);
    if (this.followCamera) this.viewport.follow(this.robot.rootPose().p);
    this.hudTimer += dt;
    if (this.hudTimer > 0.1) {
      this.hudTimer = 0;
      this.renderHud();
      updateLiveReadouts(this.el.inspector, this.robot);
      const s = this.scopeKey ? this.robot.dofs.get(this.scopeKey) : undefined;
      if (s) {
        const u = s.config.drive.mode === 'motor' ? signalUnits(s.def, 'motor') : positionUnits(s.def);
        this.scope.draw(u.scale, u.unit === '°' ? '°' : ` ${u.unit}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.viewport.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.pointerDown;
      this.pointerDown = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
      this.click(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.pointerDown) return;
      this.hover(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointerleave', () => {
      this.view?.setHoverPart(null);
      this.view?.setHoverSnap(null);
      this.el.hint.classList.remove('show-tip');
    });

    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
        return;
      }
      if (this.mode === 'sim') {
        if (e.key === 'Escape') {
          this.stopSim();
          return;
        }
        if (!mod) {
          this.sim?.keys.add(e.code);
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
        }
        return;
      }
      if (e.key === 'Escape') this.select(null, null);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedPart) this.deletePart(this.selectedPart);
      else if (e.key.toLowerCase() === 'r' && this.selectedPart) this.rotateSelected(e.shiftKey ? -Math.PI / 2 : Math.PI / 2);
    });
    window.addEventListener('keyup', (e) => this.sim?.keys.delete(e.code));
    window.addEventListener('blur', () => this.sim?.keys.clear());
  }

  /**
   * Snap markers are picked on screen with a generous radius and win over
   * parts, so markers seen through a part can still be clicked.
   */
  private pickAt(x: number, y: number): THREE.Intersection | null {
    if (!this.view) return null;
    let best: { d: number; marker: THREE.Mesh } | null = null;
    const world = new THREE.Vector3();
    for (const marker of this.view.snapMarkers) {
      const c = this.viewport.toClient(marker.getWorldPosition(world));
      if (c.behind) continue;
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < 11 && (!best || d < best.d)) best = { d, marker };
    }
    if (best) return { object: best.marker, point: best.marker.getWorldPosition(new THREE.Vector3()), distance: 0 } as THREE.Intersection;
    return this.viewport.pick(x, y, [...this.view.partMeshes.values()]);
  }

  private hover(x: number, y: number): void {
    if (!this.view) return;
    const hit = this.pickAt(x, y);
    const data = hit?.object.userData as (SnapMarkerData | { kind: 'part'; part: string }) | undefined;
    if (data?.kind === 'snap') {
      this.view.setHoverSnap(hit!.object as THREE.Mesh);
      this.view.setHoverPart(null);
      const part = this.bp.parts.find((p) => p.id === data.part);
      const label = part ? getSnaps(part.type, resolveSize(part.type, part.size)).find((s) => s.id === data.snap)?.label : data.snap;
      this.tip(x, y, `${data.part} · ${label}`);
    } else {
      this.view.setHoverSnap(null);
      this.view.setHoverPart(data?.kind === 'part' ? data.part : null);
      if (data?.kind === 'part') this.tip(x, y, this.mode === 'sim' ? `${data.part} — click to poke` : data.part);
      else this.el.hint.classList.remove('show-tip');
    }
  }

  private tip(x: number, y: number, text: string): void {
    const rect = this.el.hint.parentElement!.getBoundingClientRect();
    this.el.hint.textContent = text;
    this.el.hint.style.left = `${x - rect.left + 14}px`;
    this.el.hint.style.top = `${y - rect.top + 14}px`;
    this.el.hint.classList.add('show-tip');
  }

  private click(x: number, y: number): void {
    const hit = this.pickAt(x, y);
    const data = hit?.object.userData as (SnapMarkerData | { kind: 'part'; part: string }) | undefined;
    if (this.mode === 'sim') {
      if (data?.kind === 'part' && this.robot && hit) {
        // Poke: an impulse along the view ray, scaled to the robot's weight.
        const dir = this.viewport.rayDirection();
        const strength = 0.6 * Math.min(10, this.robot.totalMass());
        this.robot.applyImpulse(data.part, v3(dir.x * strength, dir.y * strength + 0.2 * strength, dir.z * strength), v3(hit.point.x, hit.point.y, hit.point.z));
        this.select(data.part, null);
      } else this.select(null, null);
      return;
    }
    if (data?.kind === 'snap') this.select(data.part, { part: data.part, snap: data.snap });
    else if (data?.kind === 'part') this.select(data.part, null);
    else this.select(null, null);
  }

  select(part: string | null, snap: { part: string; snap: string } | null): void {
    const partChanged = part !== this.selectedPart;
    this.selectedPart = part;
    this.selectedSnap = snap;
    this.view?.setSelectedPart(part);
    this.view?.setSelectedSnap(snap?.part ?? null, snap?.snap ?? null);
    this.updateAttachArrow();
    if (partChanged && this.mode === 'sim') {
      this.scopeKey = this.defaultScopeKey();
      this.scope.reset();
    }
    if (partChanged) this.renderInspector();
    this.renderPalette();
  }

  private deletePart(id: string): void {
    const joint = parentJointOf(this.bp, id);
    if (!joint) {
      this.flash('The first part holds everything else. To start over, pick "Empty plate" from Examples.');
      return;
    }
    this.commit(removePart(this.bp, id), { rerender: true });
    this.select(joint.parent.part, null);
  }

  private rotateSelected(by: number): void {
    const joint = this.selectedPart ? parentJointOf(this.bp, this.selectedPart) : undefined;
    if (!joint) return;
    let angle = (joint.angle ?? 0) + by;
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    this.commit(updateJoint(this.bp, joint.id, { angle: Math.abs(angle) < 1e-9 ? 0 : angle }), { rerender: true });
  }

  private addPart(type: PartType): void {
    if (this.mode !== 'build') return;
    if (this.bp.parts.length === 0) {
      const res = setRoot(this.bp, type);
      this.commit(res.blueprint, { rerender: true });
      this.select(res.partId, null);
      return;
    }
    if (!this.selectedSnap) {
      this.flash('First click one of the blue dots on the robot to choose where the new part goes.');
      return;
    }
    const res = attachPart(this.bp, this.selectedSnap, type, this.jointChoice);
    this.commit(res.blueprint, { rerender: true });
    // Carry on from the far end of the new part, so chains are quick to build.
    const used = getPartType(type).defaultChildSnap;
    const far = oppositeSnap(used);
    const next = far && this.snapIsFree({ part: res.partId, snap: far }) ? { part: res.partId, snap: far } : null;
    this.select(res.partId, next);
  }

  private flash(message: string): void {
    const note = h('div', { class: 'toast' }, message);
    document.body.append(note);
    setTimeout(() => note.classList.add('fade'), 3200);
    setTimeout(() => note.remove(), 4000);
  }

  // ---------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------

  private renderAll(): void {
    this.renderToolbar();
    this.renderPalette();
    this.renderInspector();
    this.renderHud();
  }

  private renderInspector(): void {
    renderInspector(this.el.inspector, {
      bp: this.bp,
      current: () => this.bp,
      mode: this.mode,
      assembly: this.assembly,
      validation: this.validation,
      selectedPart: this.selectedPart,
      robot: this.robot,
      scope: this.scope,
      scopeKey: this.scopeKey,
      commit: this.commit,
      preview: this.preview,
      selectPart: (id) => this.select(id, null),
      setScopeKey: (key) => {
        this.scopeKey = key;
        this.scope.reset();
        this.renderInspector();
      },
    });
  }

  private renderToolbar(): void {
    const t = this.el.toolbar;
    clear(t);
    const presetSelect = h('select', { title: 'Load an example robot' });
    presetSelect.append(h('option', { value: '', textContent: 'Examples…' }));
    for (const p of PRESETS) presetSelect.append(h('option', { value: p.id, textContent: p.name, title: p.summary }));
    presetSelect.addEventListener('change', () => {
      const preset = presetById(presetSelect.value);
      if (preset) this.load(preset.build(), preset.id);
    });

    const sim = this.mode === 'sim';
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        this.load(parseBlueprint(await file.text()), null);
      } catch (e) {
        this.flash(`Could not open ${file.name}: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`);
      }
    });

    t.append(
      h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'Robot Sim'),
      presetSelect,
      h(
        'div',
        { class: 'mode-switch' },
        button('Build', () => sim && this.stopSim(), { class: sim ? '' : 'active', title: 'Edit the robot (Esc)' }),
        button('▶ Simulate', () => void this.startSim(), { class: sim ? 'active' : 'primary', title: 'Run the physics' }),
      ),
    );
    if (sim) {
      const speedSel = h('select', { title: 'Simulation speed' });
      for (const s of SPEEDS) speedSel.append(h('option', { value: String(s), selected: s === this.speed, textContent: `${s}×` }));
      speedSel.addEventListener('change', () => (this.speed = Number(speedSel.value)));
      t.append(
        button(this.paused ? '▶ Resume' : '❚❚ Pause', () => {
          this.paused = !this.paused;
          this.renderToolbar();
        }),
        button('↺ Restart', () => void this.startSim(), { title: 'Start the simulation again from the beginning' }),
        speedSel,
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: this.followCamera, on: { change: (e) => {
          this.followCamera = (e.target as HTMLInputElement).checked;
          if (!this.followCamera) this.viewport.follow(null);
        } } }), 'Follow'),
      );
    }
    t.append(
      h('label', { class: 'toggle', title: 'Show joint markers (coloured by drive)' }, h('input', { type: 'checkbox', checked: this.showJoints, on: { change: (e) => {
        this.showJoints = (e.target as HTMLInputElement).checked;
        this.view?.setJointsVisible(this.showJoints);
      } } }), 'Joints'),
      h('div', { class: 'spacer' }),
      button('↶', () => this.undo(), { title: 'Undo (Ctrl+Z)', disabled: this.history.length === 0, class: 'icon' }),
      button('↷', () => this.redo(), { title: 'Redo (Ctrl+Shift+Z)', disabled: this.future.length === 0, class: 'icon' }),
      button('Save', () => this.download(), { title: 'Download this robot as a JSON blueprint' }),
      button('Open', () => fileInput.click(), { title: 'Load a JSON blueprint' }),
      fileInput,
      button('?', () => this.el.help.showModal(), { title: 'How does this work?', class: 'icon' }),
    );
  }

  private download(): void {
    const blob = new Blob([serializeBlueprint(this.bp)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${(this.bp.name || 'robot').replace(/[^\w-]+/g, '_').toLowerCase()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private renderPalette(): void {
    const p = this.el.palette;
    clear(p);
    const sim = this.mode === 'sim';
    const empty = this.bp.parts.length === 0;
    const target = this.selectedSnap;
    const targetLabel = (() => {
      if (!target) return null;
      const part = this.bp.parts.find((x) => x.id === target.part);
      if (!part) return null;
      return getSnaps(part.type, resolveSize(part.type, part.size)).find((s) => s.id === target.snap)?.label ?? target.snap;
    })();

    p.append(
      h(
        'div',
        { class: `step ${sim ? 'disabled' : ''}` },
        h('div', { class: 'step-title' }, h('span', { class: 'num' }, '1'), ' Where?'),
        empty
          ? h('p', { class: 'hint' }, 'Pick any part below to start your robot.')
          : target
            ? h('p', { class: 'target' }, h('b', {}, target.part), ` · ${targetLabel}`)
            : h('p', { class: 'hint' }, 'Click a blue dot on the robot.'),
      ),
    );

    const jointList = h('div', { class: 'joint-list' });
    for (const family of ['natural', 'robotic'] as const) {
      jointList.append(h('div', { class: 'family' }, family === 'natural' ? 'From nature' : 'Robotic'));
      for (const j of JOINT_TYPE_LIST.filter((x) => x.family === family)) {
        const b = h(
          'button',
          {
            type: 'button',
            class: `joint-choice ${this.jointChoice === j.type ? 'active' : ''}`,
            title: `${j.description}\n${j.dofs.length ? `Moves: ${j.dofs.map((d) => d.name).join(', ')}` : 'No motion'}`,
            disabled: sim,
            on: {
              click: () => {
                this.jointChoice = j.type;
                this.renderPalette();
              },
            },
          },
          h('span', { class: 'jc-name' }, j.label, h('span', { class: 'dof-count' }, j.dofs.length ? `${j.dofs.length} DOF` : 'rigid')),
          h('span', { class: 'jc-analog' }, j.analog),
        );
        jointList.append(b);
      }
    }
    p.append(h('div', { class: `step ${sim || empty ? 'disabled' : ''}` }, h('div', { class: 'step-title' }, h('span', { class: 'num' }, '2'), ' Joint'), jointList));

    const parts = h('div', { class: 'part-grid' });
    for (const def of PART_TYPE_LIST) {
      parts.append(
        h(
          'button',
          { type: 'button', class: 'part-choice', title: `${def.description}\nLike: ${def.analog}`, disabled: sim || (!empty && !target), on: { click: () => this.addPart(def.type) } },
          h('span', { class: 'swatch', style: { background: def.defaultColor } }),
          h('span', {}, def.label),
        ),
      );
    }
    p.append(h('div', { class: `step ${sim ? 'disabled' : ''}` }, h('div', { class: 'step-title' }, h('span', { class: 'num' }, '3'), empty ? ' First part' : ' Add part'), parts));

    p.append(
      h(
        'div',
        { class: 'legend-box' },
        h('div', { class: 'step-title' }, 'Joint colours'),
        ...(['free', 'spring', 'servo', 'motor', 'weld'] as const).map((m) =>
          h('div', { class: 'legend-line' }, h('span', { class: 'swatch', style: { background: DRIVE_COLORS[m] } }), {
            free: 'free — flaps loose',
            spring: 'spring — elastic',
            servo: 'servo — follows a signal',
            motor: 'motor — driven speed',
            weld: 'weld — rigid',
          }[m]),
        ),
      ),
    );
    if (!sim && this.selectedPart && parentJointOf(this.bp, this.selectedPart)) {
      p.append(h('p', { class: 'hint small' }, 'Selected part: R / Shift+R turns its joint 90°, Delete removes it.'));
    }
  }

  private renderHud(): void {
    const hud = this.el.hud;
    clear(hud);
    if (this.mode !== 'sim' || !this.robot) {
      const root = findRoot(this.bp);
      hud.append(h('div', { class: 'hud-line' }, `${this.bp.name}`, h('span', { class: 'muted' }, ` · ${this.bp.parts.length} parts · ${root ? 'build mode' : 'empty'}`)));
      return;
    }
    const t = this.robot.telemetry();
    hud.append(
      h('div', { class: 'hud-line big' }, `${t.time.toFixed(1)} s`, this.paused ? h('span', { class: 'paused' }, ' paused') : null),
      h('div', { class: 'hud-line' }, `distance ${t.distance.toFixed(2)} m · speed ${t.speed.toFixed(2)} m/s`),
      h('div', { class: 'hud-line' }, `height ${t.height.toFixed(2)} m · tilt ${((t.tilt * 180) / Math.PI).toFixed(0)}°`),
    );
    const keys = keysUsed(this.bp);
    const preset = this.presetId ? presetById(this.presetId) : undefined;
    if (preset?.controls) hud.append(h('div', { class: 'hud-line keys' }, `🎮 ${preset.controls}`));
    else if (keys.length) hud.append(h('div', { class: 'hud-line keys' }, `🎮 keys: ${keys.join(' ')}`));
    hud.append(h('div', { class: 'hud-line muted' }, 'click a part to poke it · Esc to stop'));
  }
}
