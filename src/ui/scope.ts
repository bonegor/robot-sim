/**
 * A small oscilloscope: plots a joint's actual position against its target.
 */
import { h } from './dom';

interface Sample {
  t: number;
  actual: number;
  target: number | null;
}

export class Scope {
  readonly canvas: HTMLCanvasElement;
  private samples: Sample[] = [];

  constructor(
    private readonly window = 5,
    width = 260,
    height = 90,
  ) {
    this.canvas = h('canvas', { class: 'scope', width, height });
  }

  push(t: number, actual: number, target: number | null): void {
    this.samples.push({ t, actual, target });
    while (this.samples.length && this.samples[0]!.t < t - this.window) this.samples.shift();
  }

  reset(): void {
    this.samples = [];
  }

  draw(scale = 1, unit = ''): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width: w, height: hgt } = this.canvas;
    ctx.clearRect(0, 0, w, hgt);
    if (this.samples.length < 2) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.samples) {
      lo = Math.min(lo, s.actual, s.target ?? s.actual);
      hi = Math.max(hi, s.actual, s.target ?? s.actual);
    }
    const pad = Math.max(0.05, (hi - lo) * 0.15);
    lo -= pad;
    hi += pad;
    const t1 = this.samples[this.samples.length - 1]!.t;
    const t0 = t1 - this.window;
    const x = (t: number) => ((t - t0) / this.window) * w;
    const y = (v: number) => hgt - 4 - ((v - lo) / (hi - lo)) * (hgt - 8);
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = 'rgba(127,127,127,0.35)';
      ctx.beginPath();
      ctx.moveTo(0, y(0));
      ctx.lineTo(w, y(0));
      ctx.stroke();
    }
    const line = (pick: (s: Sample) => number | null, color: string, dash: number[]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (const s of this.samples) {
        const v = pick(s);
        if (v === null) continue;
        if (!started) ctx.moveTo(x(s.t), y(v));
        else ctx.lineTo(x(s.t), y(v));
        started = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line((s) => s.target, '#f77f00', [5, 4]);
    line((s) => s.actual, '#1fb6ff', []);
    ctx.fillStyle = 'rgba(127,127,127,0.9)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${(hi * scale).toFixed(1)}${unit}`, 4, 11);
    ctx.fillText(`${(lo * scale).toFixed(1)}${unit}`, 4, hgt - 4);
  }
}
