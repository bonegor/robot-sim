import { describe, expect, it } from 'vitest';
import { dot, length } from '../src/core/math';
import { PART_TYPE_LIST, getSnaps, resolveSize, shapeSignedDistance } from '../src/core/parts';

describe('part catalog', () => {
  for (const def of PART_TYPE_LIST) {
    describe(def.label, () => {
      const size = resolveSize(def.type);
      const shape = def.shape(size);
      const snaps = getSnaps(def.type, size);

      it('has uniquely named snap points', () => {
        expect(snaps.length).toBeGreaterThan(0);
        expect(new Set(snaps.map((s) => s.id)).size).toBe(snaps.length);
      });

      it('has a default child snap that exists', () => {
        expect(snaps.map((s) => s.id)).toContain(def.defaultChildSnap);
      });

      it('puts every snap point on the surface with an outward unit normal and a perpendicular up', () => {
        for (const s of snaps) {
          expect(Math.abs(shapeSignedDistance(shape, s.position)), `${s.id} on surface`).toBeLessThan(1e-9);
          expect(length(s.normal)).toBeCloseTo(1, 9);
          expect(length(s.up)).toBeCloseTo(1, 9);
          expect(Math.abs(dot(s.normal, s.up)), `${s.id} up ⟂ normal`).toBeLessThan(1e-9);
          // Stepping outwards along the normal leaves the part.
          const outside = { x: s.position.x + s.normal.x * 1e-3, y: s.position.y + s.normal.y * 1e-3, z: s.position.z + s.normal.z * 1e-3 };
          expect(shapeSignedDistance(shape, outside), `${s.id} normal points out`).toBeGreaterThan(0);
        }
      });

      it('keeps snap points on the surface when resized', () => {
        const big: Record<string, number> = {};
        for (const p of def.sizeParams) big[p.key] = Math.min(p.max, p.default * 1.7);
        const s2 = resolveSize(def.type, big);
        const shape2 = def.shape(s2);
        for (const s of getSnaps(def.type, s2)) {
          expect(Math.abs(shapeSignedDistance(shape2, s.position)), s.id).toBeLessThan(1e-9);
        }
      });
    });
  }

  it('clamps sizes to the allowed range', () => {
    const s = resolveSize('rod', { length: 999, radius: -1 });
    expect(s.length).toBe(1.5);
    expect(s.radius).toBe(0.005);
  });
});
