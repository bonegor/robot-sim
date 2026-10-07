/**
 * three.js geometry for part shapes (cached, since many parts share sizes).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Shape } from '../core/parts';

const cache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) {
    g = make();
    cache.set(key, g);
  }
  return g;
}

/** Profile of a cylinder with rounded edges, revolved around Y. */
function roundedCylinder(radius: number, halfHeight: number, rounding: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -halfHeight)];
  const steps = 6;
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= steps; i++) {
      const a = from + (i / steps) * (Math.PI / 2);
      pts.push(new THREE.Vector2(cx + rounding * Math.cos(a), cy + rounding * Math.sin(a)));
    }
  };
  corner(radius - rounding, -halfHeight + rounding, -Math.PI / 2);
  corner(radius - rounding, halfHeight - rounding, 0);
  pts.push(new THREE.Vector2(0, halfHeight));
  return new THREE.LatheGeometry(pts, 40);
}

export function shapeGeometry(shape: Shape): THREE.BufferGeometry {
  switch (shape.kind) {
    case 'box': {
      const { x, y, z } = shape.halfExtents;
      const r = Math.min(x, y, z) * 0.25;
      return cached(`box:${x}:${y}:${z}`, () => new RoundedBoxGeometry(2 * x, 2 * y, 2 * z, 3, r));
    }
    case 'cylinder': {
      const { radius, halfHeight, rounding = 0 } = shape;
      return cached(`cyl:${radius}:${halfHeight}:${rounding}`, () =>
        rounding > 0 ? roundedCylinder(radius, halfHeight, rounding) : new THREE.CylinderGeometry(radius, radius, 2 * halfHeight, 32),
      );
    }
    case 'capsule':
      return cached(`cap:${shape.radius}:${shape.halfHeight}`, () => new THREE.CapsuleGeometry(shape.radius, 2 * shape.halfHeight, 8, 24));
    case 'sphere':
      return cached(`sph:${shape.radius}`, () => new THREE.SphereGeometry(shape.radius, 32, 16));
  }
}

/**
 * Hub and spoke markings for round parts, so you can see them spin.
 * Returned in the part's local frame (axis = Y).
 */
export function spinMarkings(shape: Shape, color: THREE.ColorRepresentation): THREE.Object3D | null {
  if (shape.kind !== 'cylinder' || shape.halfHeight > shape.radius) return null;
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 });
  const r = shape.radius;
  const h = shape.halfHeight;
  const hubR = r * 0.32;
  for (const side of [1, -1]) {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, 0.004, 24), mat);
    hub.position.y = side * (h + 0.001);
    group.add(hub);
    for (const angle of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, 0.003, r * 0.09), mat);
      spoke.position.y = side * (h + 0.0015);
      spoke.rotation.y = angle;
      group.add(spoke);
    }
  }
  group.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });
  return group;
}
