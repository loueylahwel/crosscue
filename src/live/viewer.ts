/// <reference types="webxr" />
import * as THREE from 'three';
import { MeshNode } from '../core/mesh';
import { alignFromTwoPoints, toLocal, toWorld } from '../core/transform';
import type { Pose4, Vec3 } from '../core/types';
import { WorldModel, type TrackView } from '../core/worldModel';
import { postReport } from './report';
import { loadSetting, saveSetting } from './settings';
import { WebSocketTransport } from './wsTransport';

/**
 * FTX viewer (Android Chrome, WebXR immersive-ar). Receives sightings over the relay, fuses them into the
 * COP, and draws each target at its place in the room. Alignment with DATUM: tap the origin marker's
 * centre, then the middle of its right-hand edge (+X); both taps become anchors so ARCore can keep
 * correcting them. Without AR it still shows a top-down map, which is how it is checked on a PC.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settings = loadSetting('viewer', { relayUrl: `ws://${location.hostname || 'localhost'}:8787`, nodeId: 'PHONE' });

// ---- network and COP --------------------------------------------------------------------------

const cop = new WorldModel();
let transport: WebSocketTransport | null = null;
let mesh: MeshNode | null = null;

function connect(): void {
  transport?.close();
  transport = new WebSocketTransport({ url: settings.relayUrl, id: settings.nodeId });
  mesh = new MeshNode(transport, { ttl: 4, relay: true });
  mesh.onObservation((obs, meta) => cop.ingest(obs, performance.now(), meta.hops.length - 1));
}

for (const [id, key] of [
  ['relayUrl', 'relayUrl'],
  ['nodeId', 'nodeId'],
] as const) {
  const el = $<HTMLInputElement>(id);
  el.value = settings[key];
  el.addEventListener('change', () => {
    settings[key] = el.value.trim() || settings[key];
    saveSetting('viewer', settings);
    connect();
  });
}

// ---- alignment state --------------------------------------------------------------------------

type Phase = 'origin' | 'xaxis' | 'aligned';
const ar = {
  phase: 'origin' as Phase,
  tapOrigin: null as Vec3 | null,
  tapX: null as Vec3 | null,
  anchorOrigin: null as XRAnchor | null,
  anchorX: null as XRAnchor | null,
  align: null as Pose4 | null, // local (XR reference space) -> W
  me: null as { pos: Vec3; yaw: number } | null, // phone pose in W
  hit: null as XRHitTestResult | null,
  hitPos: null as Vec3 | null,
  fps: 0,
};

function realign(): void {
  ar.anchorOrigin?.delete();
  ar.anchorX?.delete();
  Object.assign(ar, { phase: 'origin', tapOrigin: null, tapX: null, anchorOrigin: null, anchorX: null, align: null });
}

function updateAlign(): void {
  if (!ar.tapOrigin || !ar.tapX) return;
  try {
    ar.align = alignFromTwoPoints(ar.tapOrigin, ar.tapX);
  } catch {
    /* taps coincide: keep the previous alignment */
  }
}

// ---- top-down map (works with or without AR) -------------------------------------------------------

function drawMap(canvas: HTMLCanvasElement, tracks: TrackView[]): void {
  const g = canvas.getContext('2d')!;
  const W = canvas.width;
  const range = 8; // metres from the centre to the edge
  const s = W / 2 / range;
  const P = (x: number, z: number): [number, number] => [W / 2 + x * s, W / 2 + z * s]; // -Z (heading 0) is up
  g.fillStyle = '#070b10';
  g.fillRect(0, 0, W, W);
  g.strokeStyle = 'rgba(34, 211, 238, 0.14)';
  g.lineWidth = 1;
  for (let i = -range; i <= range; i++) {
    g.beginPath();
    g.moveTo(...P(i, -range));
    g.lineTo(...P(i, range));
    g.moveTo(...P(-range, i));
    g.lineTo(...P(range, i));
    g.stroke();
  }
  // origin marker and W axes
  g.lineWidth = 2;
  g.strokeStyle = '#f87171';
  g.beginPath();
  g.moveTo(...P(0, 0));
  g.lineTo(...P(1, 0));
  g.stroke();
  g.strokeStyle = '#60a5fa';
  g.beginPath();
  g.moveTo(...P(0, 0));
  g.lineTo(...P(0, 1));
  g.stroke();
  g.fillStyle = '#facc15';
  g.fillRect(...P(-0.08, -0.08), 0.16 * s, 0.16 * s);

  for (const t of tracks) {
    const [x, y] = P(t.pos[0], t.pos[2]);
    g.strokeStyle = g.fillStyle = t.stale ? '#9ca3af' : '#22d3ee';
    g.globalAlpha = 0.35 + 0.65 * t.freshness;
    g.beginPath();
    g.arc(x, y, Math.max(3, t.sigma * s), 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
    g.font = `${Math.round(W / 30)}px system-ui, sans-serif`;
    g.fillText(t.id ?? t.label, x + 7, y - 7);
    g.globalAlpha = 1;
  }
  if (ar.me) {
    const [x, y] = P(ar.me.pos[0], ar.me.pos[2]);
    const a = ar.me.yaw;
    const fwd = (r: number, da: number): [number, number] => [x - Math.sin(a + da) * r, y - Math.cos(a + da) * r];
    g.fillStyle = '#4ade80';
    g.beginPath();
    g.moveTo(...fwd(12, 0));
    g.lineTo(...fwd(8, 2.5));
    g.lineTo(...fwd(8, -2.5));
    g.closePath();
    g.fill();
  }
}

function describe(t: TrackView): string {
  const where = ar.me ? `${Math.hypot(t.pos[0] - ar.me.pos[0], t.pos[2] - ar.me.pos[2]).toFixed(1)} m` : `${t.pos.map((v) => v.toFixed(2)).join(', ')}`;
  return `${t.id ?? t.label}  ${where}  via ${t.lastOrigin} (${t.lastHops} hop${t.lastHops === 1 ? '' : 's'})  sigma ${(t.sigma * 100).toFixed(0)} cm${t.stale ? '  stale' : ''}`;
}

// ---- start screen loop (no AR) ----------------------------------------------------------------

function startScreen(): void {
  const tracks = cop.current(performance.now());
  drawMap($<HTMLCanvasElement>('mapStart'), tracks);
  $('tracks').innerHTML = tracks.length ? tracks.map((t) => `<div><span>${describe(t)}</span></div>`).join('') : 'None yet.';
  const t = transport;
  $('net').textContent = t ? `Relay ${t.status}, neighbours: ${t.neighbors().join(', ') || 'none'}, received ${t.stats.received}${t.notice ? `, ${t.notice}` : ''}` : '';
}
setInterval(() => {
  if (!session) startScreen();
}, 250);

// ---- AR ---------------------------------------------------------------------------------------

let session: XRSession | null = null;
const overlay = $('overlay');
const labels = $('labels');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.02, 100);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
);
reticle.visible = false;
scene.add(reticle);

const tapDot = (color: number) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.015, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.visible = false;
  m.renderOrder = 20;
  scene.add(m);
  return m;
};
const dotOrigin = tapDot(0xfacc15);
const dotX = tapDot(0xf87171);
const axes = new THREE.AxesHelper(0.3);
axes.visible = false;
(axes.material as THREE.Material).depthTest = false;
axes.renderOrder = 20;
scene.add(axes);

interface Ghost {
  group: THREE.Group;
  sphere: THREE.Mesh;
  ring: THREE.Mesh;
  stem: THREE.Line;
  label: HTMLDivElement;
}
const ghosts = new Map<string, Ghost>();

function ghost(key: string): Ghost {
  let g = ghosts.get(key);
  if (g) return g;
  const mat = () => new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, depthTest: false, side: THREE.DoubleSide });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.07, 20, 14), mat());
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2), mat());
  const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, depthTest: false }));
  for (const o of [sphere, ring, stem]) o.renderOrder = 10; // drawn over everything: targets show through walls
  const group = new THREE.Group();
  group.add(sphere, ring, stem);
  scene.add(group);
  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = '<span class="arrow"></span><span class="text"></span>';
  labels.appendChild(label);
  g = { group, sphere, ring, stem, label };
  ghosts.set(key, g);
  return g;
}

const tmp = new THREE.Vector3();

function updateGhosts(xrCam: THREE.Camera): void {
  const tracks = cop.current(performance.now());
  const seen = new Set<string>();
  const A = ar.align;
  if (A) {
    for (const t of tracks) {
      seen.add(t.key);
      const g = ghost(t.key);
      const p = toLocal(A, t.pos);
      const floor = toLocal(A, [t.pos[0], 0, t.pos[2]]);
      const color = new THREE.Color(t.stale ? 0x9ca3af : 0x22d3ee);
      const opacity = 0.35 + 0.65 * t.freshness;
      g.group.visible = true;
      g.sphere.position.set(...p);
      g.ring.position.set(...floor);
      g.ring.scale.setScalar(Math.max(0.05, t.sigma));
      const pos = g.stem.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, ...floor);
      pos.setXYZ(1, ...p);
      pos.needsUpdate = true;
      for (const o of [g.sphere, g.ring, g.stem]) {
        const m = o.material as THREE.MeshBasicMaterial;
        m.color = color;
        m.opacity = opacity;
      }
      placeLabel(g.label, tmp.set(...p), xrCam, describe(t), t.stale ? '#9ca3af' : '#22d3ee');
    }
  }
  for (const [key, g] of ghosts) {
    if (seen.has(key)) continue;
    g.group.visible = false;
    g.label.style.display = 'none';
    if (!tracks.some((t) => t.key === key)) {
      scene.remove(g.group);
      g.label.remove();
      ghosts.delete(key);
    }
  }
}

/** Put a label on the target, or on the screen edge with an arrow when the target is off screen. */
function placeLabel(el: HTMLDivElement, world: THREE.Vector3, cam: THREE.Camera, text: string, color: string): void {
  el.style.display = '';
  el.style.color = color;
  (el.querySelector('.text') as HTMLSpanElement).textContent = text;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const inCam = world.clone().applyMatrix4(cam.matrixWorldInverse);
  const ndc = world.clone().project(cam);
  const onScreen = inCam.z < 0 && Math.abs(ndc.x) <= 0.92 && Math.abs(ndc.y) <= 0.92;
  if (onScreen) {
    el.classList.remove('edge');
    el.style.transform = `translate(${((ndc.x + 1) / 2) * w}px, ${((1 - ndc.y) / 2) * h}px) translate(-50%, -150%)`;
    return;
  }
  // direction to the target in the screen plane (behind the camera: same side, pushed to the edge)
  let dx = inCam.x;
  let dy = -inCam.y;
  if (Math.hypot(dx, dy) < 1e-6) dy = 1;
  const ang = Math.atan2(dy, dx);
  const m = 40;
  const k = Math.min((w / 2 - m) / Math.abs(Math.cos(ang) || 1e-9), (h / 2 - m) / Math.abs(Math.sin(ang) || 1e-9));
  const x = w / 2 + Math.cos(ang) * k;
  const y = h / 2 + Math.sin(ang) * k;
  el.classList.add('edge');
  (el.querySelector('.arrow') as HTMLSpanElement).style.transform = `rotate(${ang}rad)`;
  el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
}

function instruction(): string {
  if (!ar.hitPos && ar.phase !== 'aligned') return 'Move the phone slowly and point at the floor until the white ring appears.';
  if (ar.phase === 'origin') return 'Put the ring on the CENTRE of the origin marker and tap the screen.';
  if (ar.phase === 'xaxis') return 'Now put the ring on the middle of the marker\'s RIGHT-HAND edge and tap.';
  return 'Aligned. Walk around: targets reported by others are drawn at their place, through walls.';
}

async function startAr(): Promise<void> {
  const xr = navigator.xr;
  if (!xr) return;
  try {
    session = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'anchors', 'local-floor'],
      domOverlay: { root: overlay },
    } as XRSessionInit);
  } catch (e) {
    $('arSupport').textContent = `Could not start AR: ${e}`;
    postReport('viewer', { event: 'start-failed', error: String(e) });
    return;
  }
  overlay.style.display = 'block';
  $('start').style.display = 'none';
  realign();
  await renderer.xr.setSession(session);
  const viewerSpace = await session.requestReferenceSpace('viewer');
  const hitSource = await session.requestHitTestSource!({ space: viewerSpace });
  postReport('viewer', { event: 'start', features: session.enabledFeatures ?? null, overlay: session.domOverlayState?.type ?? null });

  session.addEventListener('select', onSelect);
  session.addEventListener('end', () => {
    hitSource?.cancel();
    session = null;
    renderer.setAnimationLoop(null);
    overlay.style.display = 'none';
    $('start').style.display = '';
    ar.me = null;
  });

  let last = performance.now();
  let lastReport = 0;
  renderer.setAnimationLoop((_t: number, frame?: XRFrame) => {
    if (!frame) return;
    const now = performance.now();
    ar.fps = ar.fps * 0.9 + (1000 / Math.max(1, now - last)) * 0.1;
    last = now;
    const ref = renderer.xr.getReferenceSpace()!;

    const hits = hitSource ? frame.getHitTestResults(hitSource) : [];
    const hp = hits[0]?.getPose(ref);
    ar.hit = hits[0] ?? null;
    ar.hitPos = hp ? [hp.transform.position.x, hp.transform.position.y, hp.transform.position.z] : null;
    reticle.visible = !!hp && ar.phase !== 'aligned';
    if (hp) reticle.position.set(...ar.hitPos!);

    // anchors keep the two taps where ARCore now believes they are
    for (const [anchor, key] of [
      [ar.anchorOrigin, 'tapOrigin'],
      [ar.anchorX, 'tapX'],
    ] as const) {
      if (!anchor || !frame.trackedAnchors?.has(anchor)) continue;
      const p = frame.getPose(anchor.anchorSpace, ref)?.transform.position;
      if (p) ar[key] = [p.x, p.y, p.z];
    }
    updateAlign();
    dotOrigin.visible = !!ar.tapOrigin;
    if (ar.tapOrigin) dotOrigin.position.set(...ar.tapOrigin);
    dotX.visible = !!ar.tapX;
    if (ar.tapX) dotX.position.set(...ar.tapX);
    axes.visible = !!ar.align;
    if (ar.align) {
      axes.position.set(...toLocal(ar.align, [0, 0, 0]));
      axes.rotation.set(0, -ar.align.yaw, 0);
    }

    renderer.render(scene, camera);
    const xrCam = renderer.xr.getCamera();
    if (ar.align) {
      const p = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
      const f = new THREE.Vector3(0, 0, -1).transformDirection(xrCam.matrixWorld);
      ar.me = { pos: toWorld(ar.align, [p.x, p.y, p.z]), yaw: Math.atan2(-f.x, -f.z) + ar.align.yaw };
    }
    updateGhosts(xrCam);

    $('instruction').textContent = instruction();
    const t = transport;
    $('arStatus').textContent = `${t ? `relay ${t.status}, ${t.stats.received} rx` : 'no relay'} | ${ar.fps.toFixed(0)} fps${ar.me ? ` | you ${ar.me.pos[0].toFixed(1)}, ${ar.me.pos[2].toFixed(1)}` : ''}`;
    drawMap($<HTMLCanvasElement>('mapAr'), cop.current(now));

    if (now - lastReport > 5000) {
      lastReport = now;
      postReport('viewer', {
        event: 'status',
        phase: ar.phase,
        align: ar.align,
        me: ar.me,
        anchors: !!(ar.anchorOrigin && ar.anchorX),
        fps: Math.round(ar.fps),
        tracks: cop.current(now).map((v) => ({ key: v.key, pos: v.pos, sigma: v.sigma, stale: v.stale, hops: v.lastHops })),
      });
    }
  });
}

function onSelect(): void {
  if (ar.phase === 'aligned' || !ar.hitPos) return;
  const p = [...ar.hitPos] as Vec3;
  const hit = ar.hit;
  const which = ar.phase === 'origin' ? 'Origin' : 'X';
  ar[`tap${which}`] = p;
  // an anchor attached to the detected floor follows ARCore's corrections; not every phone has anchors
  hit?.createAnchor?.()
    .then((a) => {
      if (ar[`tap${which}`] === p) ar[`anchor${which}`] = a;
      else a.delete();
    })
    .catch(() => undefined);
  if (ar.phase === 'origin') {
    ar.phase = 'xaxis';
  } else {
    updateAlign();
    if (!ar.align) {
      ar.phase = 'xaxis'; // second tap on top of the first: try again
      return;
    }
    ar.phase = 'aligned';
    postReport('viewer', { event: 'aligned', tapOrigin: ar.tapOrigin, tapX: ar.tapX, align: ar.align, edgeDistance: Math.hypot(ar.tapX![0] - ar.tapOrigin![0], ar.tapX![2] - ar.tapOrigin![2]) });
  }
}

// Buttons on the overlay must not also count as taps on the floor.
overlay.querySelector('.bottom')!.addEventListener('beforexrselect', (e) => e.preventDefault());
$('realign').addEventListener('click', realign);
$('exit').addEventListener('click', () => session?.end());
$('startAr').addEventListener('click', () => startAr());

(async () => {
  let ok = false;
  try {
    ok = !!(await navigator.xr?.isSessionSupported('immersive-ar'));
  } catch {
    /* not supported */
  }
  ($('startAr') as HTMLButtonElement).disabled = !ok;
  $('arSupport').textContent = ok ? '' : 'AR is not available in this browser; the map below still works.';
})();

connect();

// Debug handle for the browser console.
(window as unknown as { __viewer: unknown }).__viewer = { cop, ar, settings, startScreen };
