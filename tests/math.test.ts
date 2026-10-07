import { describe, expect, it } from 'vitest';
import {
  composePose,
  cross,
  invertPose,
  qangleBetween,
  qaxisAngle,
  qfromBasis,
  qfromUnitVectors,
  qmul,
  qrotate,
  transformPoint,
  v3,
  wrapAngle,
} from '../src/core/math';

const close = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
};

describe('math', () => {
  it('rotates vectors with axis-angle quaternions', () => {
    close(qrotate(qaxisAngle(v3(0, 0, 1), Math.PI / 2), v3(1, 0, 0)), v3(0, 1, 0));
    close(qrotate(qaxisAngle(v3(1, 0, 0), Math.PI / 2), v3(0, 1, 0)), v3(0, 0, 1));
    close(qrotate(qaxisAngle(v3(0, 1, 0), Math.PI), v3(1, 0, 1)), v3(-1, 0, -1));
  });

  it('builds a rotation from an orthonormal basis', () => {
    const x = v3(0, 0, -1);
    const y = v3(0, 1, 0);
    const z = cross(x, y);
    const q = qfromBasis(x, y, z);
    close(qrotate(q, v3(1, 0, 0)), x);
    close(qrotate(q, v3(0, 1, 0)), y);
    close(qrotate(q, v3(0, 0, 1)), z);
  });

  it('finds the shortest arc between unit vectors, including opposite ones', () => {
    close(qrotate(qfromUnitVectors(v3(1, 0, 0), v3(0, 0, 1)), v3(1, 0, 0)), v3(0, 0, 1));
    close(qrotate(qfromUnitVectors(v3(0, 1, 0), v3(0, -1, 0)), v3(0, 1, 0)), v3(0, -1, 0));
  });

  it('composes and inverts poses', () => {
    const a = { p: v3(1, 2, 3), q: qaxisAngle(v3(0, 1, 0), 0.7) };
    const b = { p: v3(-0.5, 0.25, 2), q: qaxisAngle(v3(1, 1, 0), -1.1) };
    const ab = composePose(a, b);
    close(transformPoint(ab, v3(0.3, -0.2, 0.1)), transformPoint(a, transformPoint(b, v3(0.3, -0.2, 0.1))));
    const id = composePose(a, invertPose(a));
    close(id.p, v3());
    expect(qangleBetween(id.q, { x: 0, y: 0, z: 0, w: 1 })).toBeLessThan(1e-7);
    expect(qangleBetween(qmul(a.q, b.q), ab.q)).toBeLessThan(1e-7);
  });

  it('wraps angles into (-π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5);
  });
});
