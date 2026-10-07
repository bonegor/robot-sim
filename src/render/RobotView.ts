/**
 * Draws a robot: one mesh per part, a gizmo per joint (coloured by how it is
 * driven) and, while building, a marker on every free snap point.
 */
import * as THREE from 'three';
import type { AssembledJoint, Assembly } from '../core/assembly';
import { snapFrame } from '../core/assembly';
import { type Blueprint, usedSnaps } from '../core/blueprint';
import type { DriveMode } from '../core/drives';
import { type Pose, composePose } from '../core/math';
import { getSnaps } from '../core/parts';
import type { Robot } from '../physics/simulation';
import { shapeGeometry, spinMarkings } from './geometry';

export const DRIVE_COLORS: Record<DriveMode | 'weld', string> = {
  free: '#7cc6fe',
  spring: '#52b788',
  servo: '#f77f00',
  motor: '#d62ad6',
  weld: '#6c757d',
};

export interface SnapMarkerData {
  kind: 'snap';
  part: string;
  snap: string;
}

export interface PartMeshData {
  kind: 'part';
  part: string;
}

const MARKER_COLOR = new THREE.Color('#1fb6ff');
const MARKER_HOVER = new THREE.Color('#ffffff');
const MARKER_SELECTED = new THREE.Color('#ffd60a');

/** The "most active" drive of a joint decides its gizmo colour. */
export function jointDriveSummary(j: AssembledJoint): DriveMode | 'weld' {
  if (j.dofs.length === 0) return 'weld';
  const modes = new Set(j.dofs.map((d) => d.drive.mode));
  for (const m of ['motor', 'servo', 'spring', 'free'] as const) if (modes.has(m)) return m;
  return 'free';
}

const applyPose = (obj: THREE.Object3D, pose: Pose) => {
  obj.position.set(pose.p.x, pose.p.y, pose.p.z);
  obj.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
};

function jointGizmo(j: AssembledJoint, size: number): THREE.Object3D {
  const color = DRIVE_COLORS[jointDriveSummary(j)];
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 });
  const g = new THREE.Group();
  const ring = (axis: 'x' | 'y' | 'z', scale = 1) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(size * scale, size * 0.14, 8, 32), mat);
    // A torus lies in its XY plane (normal Z); turn it so its normal is the axis.
    if (axis === 'x') m.rotation.y = Math.PI / 2;
    if (axis === 'y') m.rotation.x = Math.PI / 2;
    g.add(m);
  };
  const pin = (axis: 'x' | 'y' | 'z', length = 2.6) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.12, size * 0.12, size * length, 10), mat);
    // Cylinders run along Y.
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    g.add(m);
  };
  switch (j.def.type) {
    case 'weld':
      g.add(new THREE.Mesh(new THREE.BoxGeometry(size * 0.9, size * 0.9, size * 0.9), mat));
      break;
    case 'hinge':
      ring('x');
      pin('x');
      break;
    case 'pivot':
      ring('z');
      pin('z', 1.6);
      break;
    case 'wheel':
      ring('z', 0.8);
      pin('z', 3);
      break;
    case 'ball':
    case 'spine': {
      const s = new THREE.Mesh(new THREE.SphereGeometry(size * (j.def.type === 'spine' ? 0.6 : 0.75), 20, 12), mat);
      if (j.def.type === 'spine') s.scale.set(1, 1, 0.55);
      g.add(s);
      break;
    }
    case 'saddle':
    case 'condyloid':
      ring('x');
      ring('y', 0.75);
      break;
    case 'gliding': {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(size * 1.8, size * 1.8, size * 0.25), mat);
      g.add(plate);
      break;
    }
    case 'slider': {
      pin('z', 3.5);
      const collar = new THREE.Mesh(new THREE.BoxGeometry(size * 0.8, size * 0.8, size * 0.8), mat);
      g.add(collar);
      break;
    }
  }
  g.traverse((o) => {
    o.userData = { kind: 'joint', joint: j.spec.id };
  });
  return g;
}

export class RobotView {
  readonly group = new THREE.Group();
  readonly partMeshes = new Map<string, THREE.Mesh>();
  readonly snapMarkers: THREE.Mesh[] = [];
  private readonly gizmos = new Map<string, { obj: THREE.Object3D; joint: AssembledJoint }>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private selectedPart: string | null = null;
  private hoverPart: string | null = null;
  private selectedSnap: string | null = null;
  private hoverSnap: THREE.Mesh | null = null;
  private readonly markerGeo = new THREE.SphereGeometry(1, 16, 10);

  constructor(
    readonly assembly: Assembly,
    options: { snaps: boolean; joints: boolean },
  ) {
    const bp: Blueprint = assembly.blueprint;
    const markerGeo = this.markerGeo;

    for (const [id, part] of assembly.parts) {
      const mat = new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.55, metalness: 0.1 });
      this.materials.set(id, mat);
      const mesh = new THREE.Mesh(shapeGeometry(part.shape), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'part', part: id } satisfies PartMeshData;
      const marks = spinMarkings(part.shape, new THREE.Color(part.color).offsetHSL(0, 0, 0.25));
      if (marks) mesh.add(marks);
      applyPose(mesh, part.pose);
      this.group.add(mesh);
      this.partMeshes.set(id, mesh);

      if (options.snaps) {
        const used = usedSnaps(bp, id);
        const minDim = Math.min(...Object.values(part.size));
        const r = Math.min(0.011, Math.max(0.006, minDim * 0.3));
        for (const s of getSnaps(part.spec.type, part.size)) {
          if (used.has(s.id)) continue;
          const marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.9 }));
          // A faint twin drawn through everything, so snaps hidden behind or under parts can still be found.
          const ghost = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false }));
          ghost.renderOrder = 10;
          ghost.raycast = () => {};
          marker.add(ghost);
          marker.scale.setScalar(r);
          marker.position.set(s.position.x + s.normal.x * r * 0.5, s.position.y + s.normal.y * r * 0.5, s.position.z + s.normal.z * r * 0.5);
          marker.userData = { kind: 'snap', part: id, snap: s.id, radius: r } satisfies SnapMarkerData & { radius: number };
          mesh.add(marker);
          this.snapMarkers.push(marker);
        }
      }
    }

    if (options.joints) {
      for (const [id, j] of assembly.joints) {
        const a = assembly.parts.get(j.parent)!;
        const b = assembly.parts.get(j.child)!;
        const dims = [...Object.values(a.size), ...Object.values(b.size)];
        const size = Math.min(0.05, Math.max(0.014, Math.min(...dims) * 0.9));
        const obj = jointGizmo(j, size);
        applyPose(obj, j.worldFrame);
        this.group.add(obj);
        this.gizmos.set(id, { obj, joint: j });
      }
    }
  }

  /** Moves every mesh to where the physics bodies are. */
  syncFromRobot(robot: Robot): void {
    for (const [id, mesh] of this.partMeshes) {
      const body = robot.parts.get(id)?.body;
      if (!body) continue;
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    for (const { obj, joint } of this.gizmos.values()) {
      const parent = this.partMeshes.get(joint.parent)!;
      const pose: Pose = {
        p: { x: parent.position.x, y: parent.position.y, z: parent.position.z },
        q: { x: parent.quaternion.x, y: parent.quaternion.y, z: parent.quaternion.z, w: parent.quaternion.w },
      };
      applyPose(obj, composePose(pose, joint.frameInParent));
    }
  }

  setJointsVisible(visible: boolean): void {
    for (const { obj } of this.gizmos.values()) obj.visible = visible;
  }

  setSelectedPart(id: string | null): void {
    this.selectedPart = id;
    this.refreshHighlights();
  }

  setHoverPart(id: string | null): void {
    if (this.hoverPart === id) return;
    this.hoverPart = id;
    this.refreshHighlights();
  }

  private refreshHighlights(): void {
    for (const [id, mat] of this.materials) {
      const selected = id === this.selectedPart;
      const hover = id === this.hoverPart;
      mat.emissive.set(selected ? '#ffb703' : hover ? '#4cc9f0' : '#000000');
      mat.emissiveIntensity = selected ? 0.45 : hover ? 0.25 : 0;
    }
  }

  setSelectedSnap(part: string | null, snap: string | null): void {
    this.selectedSnap = part && snap ? `${part}/${snap}` : null;
    this.refreshMarkers();
  }

  setHoverSnap(marker: THREE.Mesh | null): void {
    if (this.hoverSnap === marker) return;
    this.hoverSnap = marker;
    this.refreshMarkers();
  }

  private refreshMarkers(): void {
    for (const m of this.snapMarkers) {
      const d = m.userData as SnapMarkerData & { radius: number };
      const selected = `${d.part}/${d.snap}` === this.selectedSnap;
      const hover = m === this.hoverSnap;
      const color = selected ? MARKER_SELECTED : hover ? MARKER_HOVER : MARKER_COLOR;
      (m.material as THREE.MeshBasicMaterial).color.copy(color);
      const ghost = m.children[0] as THREE.Mesh | undefined;
      if (ghost) {
        (ghost.material as THREE.MeshBasicMaterial).color.copy(color);
        (ghost.material as THREE.MeshBasicMaterial).opacity = selected || hover ? 0.75 : 0.28;
      }
      m.scale.setScalar(d.radius * (selected ? 1.7 : hover ? 1.5 : 1));
    }
  }

  /** World-space frame of a snap point, for drawing the "attach here" arrow. */
  snapWorldPose(part: string, snap: string): Pose | null {
    const p = this.assembly.parts.get(part);
    const mesh = this.partMeshes.get(part);
    if (!p || !mesh) return null;
    const s = getSnaps(p.spec.type, p.size).find((x) => x.id === snap);
    if (!s) return null;
    const meshPose: Pose = {
      p: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      q: { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
    };
    return composePose(meshPose, snapFrame(s));
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        // Part geometry is shared through the cache; only per-view resources are freed.
        const mat = o.material as THREE.Material;
        mat.dispose();
        if (!(o.userData as { kind?: string }).kind || (o.userData as { kind?: string }).kind === 'joint') o.geometry.dispose();
      }
    });
    this.markerGeo.dispose();
    this.group.removeFromParent();
  }
}
