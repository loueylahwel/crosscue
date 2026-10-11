import * as THREE from 'three';
import { toLocal, toWorld } from '../core/transform';
import type { Vec3 } from '../core/types';
import type { TrackView } from '../core/worldModel';
import { FLASH_MS, SIGHT, TARGET_CENTER_Y, type Agent, type Sim } from './sim';
import { MAP, markers, rooms, walls } from './world';

export type ViewMode = 'fps' | 'top';

/** Objects on this layer are only drawn by the top-down camera. */
const TOP_LAYER = 1;

const GHOST_OWN = 0x4ade80; // seen by this agent itself
const GHOST_SHARED = 0x22d3ee; // arrived over the radio
const GHOST_STALE = 0x9ca3af;

interface AgentVisual {
  body: THREE.Group;
  fan: THREE.Mesh;
  range: THREE.Mesh;
  belief: THREE.Mesh;
  error: THREE.Line;
}

interface GhostVisual {
  group: THREE.Group;
  wire: THREE.Mesh;
  fill: THREE.Mesh;
  ring: THREE.Mesh;
  mats: THREE.MeshBasicMaterial[];
}

/** What the HTML overlay needs to draw a label for one ghost. */
export interface GhostLabel {
  key: string;
  text: string;
  color: string;
  opacity: number;
  /** Projected position in CSS pixels inside the main view. */
  x: number;
  y: number;
  /** True when it is off screen and has been clamped to the edge. */
  clamped: boolean;
  /** Rotation of the edge arrow in radians (0 = pointing right). */
  angle: number;
}

/** Where the viewer would DRAW a shared world point: through its own, possibly wrong, pose estimate. */
export function displayPosition(viewer: Agent, shared: Vec3): Vec3 {
  return toWorld(viewer.truePose(), toLocal(viewer.estPose(), shared));
}

export class SimScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly fpsCam = new THREE.PerspectiveCamera(72, 1, 0.05, 100);
  private readonly topCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private readonly agentVis = new Map<string, AgentVisual>();
  private readonly targetVis = new Map<string, THREE.Group>();
  private readonly ghosts = new Map<string, GhostVisual>();
  private readonly links: THREE.LineSegments;
  private readonly linkPos: Float32Array;
  private readonly linkCol: Float32Array;
  private readonly anchorRings: THREE.Mesh[] = [];
  private readonly tmp = new THREE.Vector3();
  private width = 1;
  private height = 1;

  mode: ViewMode = 'fps';
  insetFraction = 0.3;
  /** CSS pixels at the left of the canvas covered by the control panel; the main view avoids them. */
  leftInset = 0;

  private get viewW(): number {
    return Math.max(1, this.width - this.leftInset);
  }

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly sim: Sim,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0b0f14);
    this.scene.fog = new THREE.Fog(0x0b0f14, 30, 60);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(8, 20, 6);
    this.scene.add(sun);

    this.buildWorld();

    const linkMax = 64; // vertex pairs
    this.linkPos = new Float32Array(linkMax * 6);
    this.linkCol = new Float32Array(linkMax * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linkPos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(this.linkCol, 3));
    lg.setDrawRange(0, 0);
    this.links = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }));
    this.links.renderOrder = 5;
    this.links.frustumCulled = false;
    this.topOnly(this.links);
    this.scene.add(this.links);
    this.topCam.layers.enable(TOP_LAYER);

    for (const a of sim.agents) this.buildAgent(a);
    for (const t of sim.targets) this.buildTarget(t.id);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
  }

  // ---- static world -------------------------------------------------------------------------

  private buildWorld(): void {
    for (const r of rooms) {
      const g = new THREE.PlaneGeometry(r.max[0] - r.min[0], r.max[1] - r.min[1]);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: r.color, roughness: 1 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set((r.min[0] + r.max[0]) / 2, 0, (r.min[1] + r.max[1]) / 2);
      this.scene.add(m);
      this.scene.add(this.roomLabel(r.name, (r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2));
    }
    const grid = new THREE.GridHelper(Math.max(MAP.width, MAP.depth), Math.max(MAP.width, MAP.depth), 0x44505e, 0x2b3440);
    grid.scale.set(1, 1, 1);
    grid.position.set(MAP.width / 2, 0.01, MAP.depth / 2);
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xc9d1d9, roughness: 0.9 });
    for (const w of walls) {
      const size = [w.max[0] - w.min[0], w.max[1] - w.min[1], w.max[2] - w.min[2]];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), wallMat);
      mesh.position.set(w.min[0] + size[0] / 2, size[1] / 2, w.min[2] + size[2] / 2);
      this.scene.add(mesh);
    }

    const tex = this.markerTexture();
    for (const m of markers) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: tex }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(m.pos[0], 0.02, m.pos[2]);
      this.scene.add(plane);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.5, 48),
        new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.25, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(m.pos[0], 0.03, m.pos[2]);
      this.topOnly(ring);
      this.scene.add(ring);
      this.anchorRings.push(ring);
    }
  }

  private markerTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#fff';
    const pattern = [
      [1, 0, 1, 1, 0],
      [0, 1, 0, 0, 1],
      [1, 1, 0, 1, 0],
      [0, 0, 1, 0, 1],
      [1, 0, 1, 1, 1],
    ];
    pattern.forEach((row, j) => row.forEach((v, i) => v && g.fillRect(9 + i * 9.2, 9 + j * 9.2, 9, 9)));
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    return t;
  }

  private roomLabel(name: string, x: number, z: number): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.font = 'bold 96px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 64, 70);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.015, z);
    return m;
  }

  // ---- agents and targets -------------------------------------------------------------------

  private buildAgent(a: Agent): void {
    const body = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: a.cfg.color, roughness: 0.5 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.0, 4, 12), mat);
    torso.position.y = 0.8;
    body.add(torso);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 12), mat);
    nose.rotation.x = -Math.PI / 2; // cone tip towards -Z (forward)
    nose.position.set(0, 1.25, -0.42);
    body.add(nose);
    this.scene.add(body);

    // Field-of-view wedge on the floor (forward is -Z).
    const steps = 24;
    const pts: number[] = [0, 0, 0];
    for (let i = 0; i <= steps; i++) {
      const th = -SIGHT.fov / 2 + (SIGHT.fov * i) / steps;
      pts.push(SIGHT.range * Math.sin(th), 0, -SIGHT.range * Math.cos(th));
    }
    const idx: number[] = [];
    for (let i = 1; i <= steps; i++) idx.push(0, i, i + 1);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    fg.setIndex(idx);
    const fan = new THREE.Mesh(
      fg,
      new THREE.MeshBasicMaterial({ color: a.cfg.color, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }),
    );
    fan.position.y = 0.04;
    this.scene.add(fan);

    const range = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1, 96),
      new THREE.MeshBasicMaterial({ color: a.cfg.color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
    );
    range.rotation.x = -Math.PI / 2;
    range.position.y = 0.05;
    this.scene.add(range);

    const belief = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.28, 24),
      new THREE.MeshBasicMaterial({ color: a.cfg.color, side: THREE.DoubleSide, depthTest: false }),
    );
    belief.rotation.x = -Math.PI / 2;
    belief.renderOrder = 4;
    this.scene.add(belief);

    const eg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const error = new THREE.Line(eg, new THREE.LineBasicMaterial({ color: a.cfg.color, depthTest: false }));
    error.renderOrder = 4;
    error.frustumCulled = false;
    this.scene.add(error);

    this.topOnly(fan, range, belief, error);
    this.agentVis.set(a.id, { body, fan, range, belief, error });
  }

  private buildTarget(id: string): void {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 1.0, 4, 12),
      new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.5 }),
    );
    body.position.y = TARGET_CENTER_Y;
    g.add(body);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.5, 32),
      new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    g.add(ring);
    this.scene.add(g);
    this.targetVis.set(id, g);
  }

  private makeGhost(): GhostVisual {
    const group = new THREE.Group();
    const geo = new THREE.CapsuleGeometry(0.34, 1.06, 4, 12);
    const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthTest: false });
    const fillMat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, side: THREE.DoubleSide });
    const wire = new THREE.Mesh(geo, wireMat);
    const fill = new THREE.Mesh(geo, fillMat);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    for (const m of [wire, fill, ring]) m.renderOrder = 10;
    group.add(fill, wire, ring);
    this.scene.add(group);
    return { group, wire, fill, ring, mats: [wireMat, fillMat, ringMat] };
  }

  // ---- per frame ----------------------------------------------------------------------------

  /** Update every mesh from the simulation state. Returns labels for the viewer's current ghosts. */
  sync(): GhostLabel[] {
    const sim = this.sim;
    const viewer = sim.viewer;
    const now = sim.net.now;

    for (const a of sim.agents) {
      const v = this.agentVis.get(a.id)!;
      const fpsSelf = this.mode === 'fps' && a === viewer;
      v.body.visible = a.alive && !fpsSelf;
      v.body.position.set(a.pos[0], 0, a.pos[2]);
      v.body.rotation.y = a.yaw;
      v.fan.visible = a.alive;
      v.fan.position.set(a.pos[0], 0.04, a.pos[2]);
      v.fan.rotation.y = a.yaw;
      const r = sim.net.nodes.get(a.id)!.range;
      v.range.visible = a.alive && r > 0;
      v.range.scale.setScalar(Math.max(r, 0.01));
      v.range.position.set(a.pos[0], 0.05, a.pos[2]);
      (v.range.material as THREE.MeshBasicMaterial).opacity = a === viewer ? 0.55 : 0.18;
      const est = a.estPose();
      v.belief.visible = a.alive;
      v.belief.position.set(est.pos[0], 0.06, est.pos[2]);
      v.error.visible = v.belief.visible;
      const ep = v.error.geometry.attributes.position as THREE.BufferAttribute;
      ep.setXYZ(0, a.pos[0], 0.06, a.pos[2]);
      ep.setXYZ(1, est.pos[0], 0.06, est.pos[2]);
      ep.needsUpdate = true;
    }

    for (const t of sim.targets) this.targetVis.get(t.id)!.position.set(t.pos[0], 0, t.pos[2]);

    const anchored = new Set(sim.agents.filter((a) => now - a.lastAnchorAt < 600).map((a) => a.atMarker));
    markers.forEach((m, i) => ((this.anchorRings[i].material as THREE.MeshBasicMaterial).opacity = anchored.has(m.id) ? 0.9 : 0.25));

    this.syncLinks(now);
    return this.syncGhosts(viewer, now);
  }

  private syncLinks(now: number): void {
    const sim = this.sim;
    let n = 0;
    for (const [a, b] of sim.net.links()) {
      const pa = sim.net.nodes.get(a)!.pos;
      const pb = sim.net.nodes.get(b)!.pos;
      const flash = Math.max(0, 1 - (now - (sim.linkFlash.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? -1e9)) / FLASH_MS);
      const o = n * 6;
      this.linkPos.set([pa[0], 0.2, pa[2], pb[0], 0.2, pb[2]], o);
      const r = 0.2 + 0.8 * flash;
      const g = 0.75 + 0.25 * flash;
      const bl = 0.35 * (1 - flash) + 0.1 * flash;
      this.linkCol.set([r, g, bl, r, g, bl], o);
      n++;
      if (n >= 64) break;
    }
    const geo = this.links.geometry;
    geo.setDrawRange(0, n * 2);
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private syncGhosts(viewer: Agent, now: number): GhostLabel[] {
    const views = viewer.model.current(now);
    const alive = new Set<string>();
    const labels: GhostLabel[] = [];
    const cam = this.mode === 'fps' ? this.fpsCam : this.topCam;
    this.updateCameras(viewer);

    for (const tr of views) {
      alive.add(tr.key);
      let g = this.ghosts.get(tr.key);
      if (!g) {
        g = this.makeGhost();
        this.ghosts.set(tr.key, g);
      }
      const p = displayPosition(viewer, tr.pos);
      const color = tr.stale ? GHOST_STALE : tr.lastHops === 0 ? GHOST_OWN : GHOST_SHARED;
      const opacity = 0.25 + 0.75 * tr.freshness;
      g.group.position.set(p[0], 0, p[2]);
      g.wire.position.y = Math.max(p[1], 0.9);
      g.fill.position.y = Math.max(p[1], 0.9);
      const radius = Math.max(tr.sigma, 0.15);
      g.ring.scale.setScalar(radius);
      g.ring.position.y = 0.07;
      g.mats[0].color.set(color);
      g.mats[0].opacity = opacity;
      g.mats[1].color.set(color);
      g.mats[1].opacity = 0.12 * opacity;
      g.mats[2].color.set(color);
      g.mats[2].opacity = 0.8 * opacity;
      labels.push(this.makeLabel(tr, viewer, p, cam, color, opacity));
    }
    for (const [key, g] of this.ghosts) {
      if (alive.has(key)) continue;
      this.scene.remove(g.group);
      g.mats.forEach((m) => m.dispose());
      this.ghosts.delete(key);
    }
    return labels;
  }

  private makeLabel(tr: TrackView, viewer: Agent, p: Vec3, cam: THREE.Camera, color: number, opacity: number): GhostLabel {
    const d = Math.hypot(p[0] - viewer.pos[0], p[2] - viewer.pos[2]);
    const who = tr.lastHops === 0 ? 'seen by you' : `via ${tr.lastOrigin}, ${tr.lastHops} hop${tr.lastHops > 1 ? 's' : ''}`;
    const age = tr.stale ? 'STALE ' : '';
    const text = `${tr.id ?? tr.label} · ${d.toFixed(1)} m · ${who} · ${age}${(tr.ageMs / 1000).toFixed(1)}s`;

    this.tmp.set(p[0], 1.9, p[2]);
    const camSpace = this.tmp.clone().applyMatrix4(cam.matrixWorldInverse);
    const behind = camSpace.z > 0;
    this.tmp.project(cam);
    let nx = this.tmp.x;
    let ny = this.tmp.y;
    if (behind) {
      nx = -nx;
      ny = -ny;
    }
    const off = behind || Math.abs(nx) > 0.92 || Math.abs(ny) > 0.88;
    if (off) {
      const k = Math.max(Math.abs(nx) / 0.92, Math.abs(ny) / 0.88, 1e-6);
      nx /= k;
      ny /= k;
      if (behind && Math.abs(nx) < 0.5 && Math.abs(ny) < 0.5) ny = -0.88; // dead behind: park at the bottom
    }
    return {
      key: tr.key,
      text,
      color: '#' + color.toString(16).padStart(6, '0'),
      opacity,
      x: this.leftInset + ((nx + 1) / 2) * this.viewW,
      y: ((1 - ny) / 2) * this.height,
      clamped: off,
      angle: Math.atan2(ny, nx),
    };
  }

  private updateCameras(viewer: Agent): void {
    this.fpsCam.aspect = this.viewW / this.height;
    this.fpsCam.updateProjectionMatrix();
    this.fpsCam.position.set(viewer.pos[0], SIGHT.eyeHeight, viewer.pos[2]);
    this.fpsCam.rotation.set(0, viewer.yaw, 0);
    this.fpsCam.updateMatrixWorld();
    this.fpsCam.matrixWorldInverse.copy(this.fpsCam.matrixWorld).invert();
    this.fitTop(this.mode === 'top' ? this.viewW / this.height : 1.6);
  }

  private fitTop(aspect: number): void {
    const margin = 1.2;
    let w = MAP.width + margin * 2;
    let h = MAP.depth + margin * 2;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    this.topCam.left = -w / 2;
    this.topCam.right = w / 2;
    this.topCam.top = h / 2;
    this.topCam.bottom = -h / 2;
    this.topCam.position.set(MAP.width / 2, 40, MAP.depth / 2);
    this.topCam.up.set(0, 0, -1);
    this.topCam.lookAt(MAP.width / 2, 0, MAP.depth / 2);
    this.topCam.updateProjectionMatrix();
    this.topCam.updateMatrixWorld();
    this.topCam.matrixWorldInverse.copy(this.topCam.matrixWorld).invert();
  }

  /** Floor-level overlays (links, FOV wedges, radio rings, pose beliefs) only make sense from above. */
  private topOnly(...objs: THREE.Object3D[]): void {
    for (const o of objs) o.layers.set(TOP_LAYER);
  }

  /** Main view full canvas, the other view as an inset in the bottom-right corner. */
  render(): void {
    const r = this.renderer;
    const main = this.mode === 'fps' ? this.fpsCam : this.topCam;
    const inset = this.mode === 'fps' ? this.topCam : this.fpsCam;
    r.setScissorTest(false);
    r.setViewport(this.leftInset, 0, this.viewW, this.height);
    r.render(this.scene, main);

    const iw = Math.round(this.width * this.insetFraction);
    const ih = Math.round(iw * (this.mode === 'fps' ? MAP.depth / MAP.width + 0.1 : 0.62));
    const x = this.width - iw - 12;
    const y = 12;
    // The inset camera needs its own aspect.
    if (inset === this.topCam) this.fitTop(iw / ih);
    else {
      this.fpsCam.aspect = iw / ih;
      this.fpsCam.updateProjectionMatrix();
    }
    r.setScissorTest(true);
    r.setScissor(x, y, iw, ih);
    r.setViewport(x, y, iw, ih);
    r.clearDepth();
    r.render(this.scene, inset);
    r.setScissorTest(false);
    // restore for next frame's label maths
    if (inset === this.topCam) this.fitTop(this.viewW / this.height);
    else {
      this.fpsCam.aspect = this.viewW / this.height;
      this.fpsCam.updateProjectionMatrix();
    }
  }
}
