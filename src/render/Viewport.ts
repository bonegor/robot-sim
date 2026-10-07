/**
 * The 3D viewport: renderer, camera with orbit controls, lights, ground and picking.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vec3 } from '../core/math';

function groundTexture(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e9edf1';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#dde3e9';
  ctx.fillRect(0, 0, size / 2, size / 2);
  ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
  ctx.strokeStyle = '#c3ccd5';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;
  readonly overlay = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly timer = new THREE.Timer();
  private frameCallbacks: ((dt: number) => void)[] = [];
  private followTarget: THREE.Vector3 | null = null;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#dbe7f2');
    this.scene.fog = new THREE.Fog('#dbe7f2', 12, 45);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    this.camera.position.set(1.4, 0.9, 1.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.2, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 30;

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#b8c4cf', 1.6));
    this.sun = new THREE.DirectionalLight('#ffffff', 2.2);
    this.sun.position.set(2.5, 5, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -3;
    s.right = s.top = 3;
    s.near = 0.5;
    s.far = 15;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.01;
    this.scene.add(this.sun, this.sun.target);

    const tex = groundTexture();
    tex.repeat.set(200, 200);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.userData = { kind: 'ground' };
    this.scene.add(ground);

    // Metre markers along X and Z.
    const axes = new THREE.Group();
    const mk = (color: string, dir: 'x' | 'z') => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(dir === 'x' ? 1 : 0.008, 0.001, dir === 'z' ? 1 : 0.008), new THREE.MeshBasicMaterial({ color }));
      m.position.set(dir === 'x' ? 0.5 : 0, 0.0005, dir === 'z' ? 0.5 : 0);
      axes.add(m);
    };
    mk('#e63946', 'x');
    mk('#2a9d8f', 'z');
    this.scene.add(axes, this.overlay);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop((time) => this.frame(time));
  }

  onFrame(cb: (dt: number) => void): void {
    this.frameCallbacks.push(cb);
  }

  private frame(time: number): void {
    this.timer.update(time);
    const dt = Math.min(0.1, this.timer.getDelta());
    for (const cb of this.frameCallbacks) cb(dt);
    if (this.followTarget) {
      const delta = this.followTarget.clone().sub(this.controls.target).multiplyScalar(Math.min(1, dt * 4));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    // Keep the shadow camera centred on what we are looking at.
    const t = this.controls.target;
    this.sun.position.set(t.x + 2.5, t.y + 5, t.z + 3);
    this.sun.target.position.copy(t);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Smoothly keep the camera aimed at a moving point (null stops following). */
  follow(target: Vec3 | null): void {
    this.followTarget = target ? new THREE.Vector3(target.x, target.y, target.z) : null;
  }

  /** Points the camera at a box, keeping the current viewing direction. */
  frameBox(min: Vec3, max: Vec3): void {
    const center = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const radius = Math.max(0.35, new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z).length() / 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.15;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
  }

  /** Nearest hit among `objects` under the pointer (client coordinates). */
  pick(clientX: number, clientY: number, objects: THREE.Object3D[], recursive = false): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, recursive)[0] ?? null;
  }

  /** Screen position (client pixels) of a world point, and whether it is behind the camera. */
  toClient(world: THREE.Vector3): { x: number; y: number; behind: boolean } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = world.clone().project(this.camera);
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, behind: p.z > 1 };
  }

  rayDirection(): THREE.Vector3 {
    return this.raycaster.ray.direction.clone();
  }
}
