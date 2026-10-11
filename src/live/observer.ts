import {
  averagePoses,
  cameraToWorld,
  column,
  intrinsicsFromHfov,
  markerSigma,
  pixelToFloor,
  projectCam,
  quadCentre,
  solveSquarePose,
  worldToCamera,
  type Intrinsics,
  type RigidPose,
  type Vec2,
} from '../core/camera';
import { dist, length } from '../core/math';
import { MeshNode } from '../core/mesh';
import type { Vec3 } from '../core/types';
import { MarkerDetector, ORIGIN_ID, TARGET_ID, type Detection } from './aruco';
import { calibrateHfov, type CalSample } from './calibrate';
import { loadSetting, saveSetting } from './settings';
import { lookAtCamera, renderScene, type SceneMarker } from './synthetic';
import { WebSocketTransport } from './wsTransport';

/**
 * FTX observer: a fixed webcam that sees the origin marker (DATUM) and the target marker, and
 * publishes the target's position in the shared world frame W over the relay.
 */

const TEST = 'test';
const LOCK_FRAMES = 30;
const PUBLISH_MS = 100;
const CORNER_NOISE_PX = 0.5; // assumed corner noise for the error model

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })!;
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;

// ---- settings ---------------------------------------------------------------------------------

const markerDefaults = loadSetting('markers', { paper: 'A4', size0: 160, size1: 160 });
const settings = loadSetting('observer', {
  source: TEST,
  hfov: 65,
  size0: markerDefaults.size0,
  size1: markerDefaults.size1,
  relayUrl: `ws://${location.hostname || 'localhost'}:8787`,
  nodeId: 'OBS',
  publish: false,
  hfovBySource: {} as Record<string, number>,
});
const save = () => saveSetting('observer', settings);

// ---- state ------------------------------------------------------------------------------------

interface DatumLock {
  pose: RigidPose;
  frames: number;
  width: number;
  height: number;
  hfov: number;
  sigma: number; // m, rough 1-sigma of the origin marker centre
  angleSigma: number; // rad, rough 1-sigma of its orientation
  rejected: number[]; // distances (m) of frames dropped as outliers
}

interface TargetFix {
  pos: Vec3; // W, from the full marker pose
  floor: Vec3 | null; // W, from the camera ray hitting the floor (only when the target lies flat)
  range: number; // m from the camera
  sigma: number;
  upright: boolean;
  rms: number;
}

const state = {
  width: 0,
  height: 0,
  K: null as Intrinsics | null,
  detections: [] as Detection[],
  originLive: null as RigidPose | null,
  originRms: 0,
  originAltRms: 0,
  lock: null as DatumLock | null,
  locking: [] as RigidPose[],
  target: null as TargetFix | null,
  truth: null as Vec3 | null, // test scene only
  fps: 0,
  procMs: 0,
  calibrating: null as { trueDist: number; samples: CalSample[] } | null,
};

const datum = (): RigidPose | null => state.lock?.pose ?? state.originLive;

// ---- sources ----------------------------------------------------------------------------------

let stream: MediaStream | null = null;
const sourceSel = $<HTMLSelectElement>('source');

async function listCameras(): Promise<void> {
  const opts: [string, string][] = [[TEST, 'Test scene (no camera)']];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices.filter((d) => d.kind === 'videoinput').forEach((d, i) => opts.push([d.deviceId || `cam${i}`, d.label || `Camera ${i + 1}`]));
  } catch {
    /* no camera API: test scene only */
  }
  sourceSel.innerHTML = opts.map(([v]) => `<option value="${v}"></option>`).join('');
  [...sourceSel.options].forEach((o, i) => (o.textContent = opts[i][1]));
  sourceSel.value = opts.some(([v]) => v === settings.source) ? settings.source : TEST;
}

async function useSource(id: string): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  settings.source = id;
  settings.hfov = settings.hfovBySource[id] ?? settings.hfov;
  hfovInput.value = String(settings.hfov);
  save();
  state.lock = loadLock(id);
  if (id === TEST) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: id.startsWith('cam') ? undefined : { exact: id }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    if (sourceSel.options.length < 2 || !sourceSel.options[1].textContent?.trim()) await listCameras(); // labels appear after permission
  } catch (e) {
    $('camInfo').textContent = `Camera failed: ${e}`;
  }
}

// The built-in test scene: a webcam on a desk, the origin flat on the floor, an upright target
// walking a loop 2 to 5 m away. Rendered with a 65 degree camera, so a different FOV setting shows
// what a miscalibrated webcam does.
const TEST_W = 960;
const TEST_H = 540;
const testCam = lookAtCamera(intrinsicsFromHfov(TEST_W, TEST_H, 65), TEST_W, TEST_H, [-0.4, 1.1, 1.6], [0.6, 0, -1.6]);
const testOrigin: SceneMarker = { id: ORIGIN_ID, size: 0.16, pos: [0, 0, 0], yaw: 0 };

function testFrame(t: number): ImageData {
  const a = t * 0.25;
  const pos: Vec3 = [0.9 + 1.1 * Math.sin(a), 0.45, -2.6 + 1.3 * Math.cos(a * 0.7)];
  const yaw = Math.atan2(testCam.pos[0] - pos[0], testCam.pos[2] - pos[2]) + 0.25 * Math.sin(a * 1.3);
  state.truth = pos;
  const target: SceneMarker = { id: TARGET_ID, size: 0.16, pos, yaw, upright: true };
  const data = renderScene(testCam, [testOrigin, target], { samples: 2, noise: 3, seed: Math.floor(t * 10) });
  return new ImageData(data, TEST_W, TEST_H);
}

let frozenAt: number | null = null;

function grabFrame(nowS: number): ImageData | null {
  if (settings.source === TEST) {
    const img = testFrame(frozenAt ?? nowS);
    frameCanvas.width = img.width;
    frameCanvas.height = img.height;
    frameCtx.putImageData(img, 0, 0);
    return img;
  }
  state.truth = null;
  if (!stream || video.readyState < 2 || !video.videoWidth) return null;
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  frameCtx.drawImage(video, 0, 0);
  return frameCtx.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
}

// ---- DATUM lock persistence (per camera, the webcam does not move) ------------------------------

function loadLock(source: string): DatumLock | null {
  const all = loadSetting('datum', {} as Record<string, DatumLock>);
  return all[source] ?? null;
}
function saveLock(source: string, lock: DatumLock | null): void {
  const all = loadSetting('datum', {} as Record<string, DatumLock>);
  if (lock) all[source] = lock;
  else delete all[source];
  saveSetting('datum', all);
}

// ---- processing -------------------------------------------------------------------------------

const detector = new MarkerDetector();

function process(img: ImageData): void {
  const t0 = performance.now();
  state.width = img.width;
  state.height = img.height;
  const K = intrinsicsFromHfov(img.width, img.height, settings.hfov);
  state.K = K;
  if (state.lock && (state.lock.width !== img.width || state.lock.height !== img.height || Math.abs(state.lock.hfov - settings.hfov) > 1e-6)) {
    state.lock = null; // resolution or FOV changed: the lock no longer applies
    saveLock(settings.source, null);
  }

  const dets = detector.detect(img);
  state.detections = dets;
  const s0 = settings.size0 / 1000;
  const s1 = settings.size1 / 1000;

  const o = dets.find((d) => d.id === ORIGIN_ID);
  const oSol = o ? solveSquarePose(o.corners, s0, K) : null;
  state.originLive = oSol?.pose ?? null;
  state.originRms = oSol?.rms ?? 0;
  state.originAltRms = oSol?.altRms ?? 0;

  if (lockPending && oSol) {
    state.locking.push(oSol.pose);
    if (state.locking.length >= LOCK_FRAMES) finishLock(K, s0);
  }

  const tDet = dets.find((d) => d.id === TARGET_ID);
  const D = datum();
  state.target = null;
  if (tDet && D) {
    const tSol = solveSquarePose(tDet.corners, s1, K);
    if (tSol) {
      const pos = cameraToWorld(D, tSol.pose.t);
      const normalW = cameraToWorld({ R: D.R, t: [0, 0, 0] }, column(tSol.pose.R, 2)); // rotate only
      const upright = Math.abs(normalW[1]) < 0.7;
      const floor = upright ? null : pixelToFloor(D, K, quadCentre(tDet.corners));
      const range = length(tSol.pose.t);
      state.target = { pos, floor, range, upright, rms: tSol.rms, sigma: targetSigma(range, s1, K, pos) };
    }
  }

  if (state.calibrating && o && tDet) {
    state.calibrating.samples.push({ origin: o.corners, target: tDet.corners });
    if (state.calibrating.samples.length >= 20) finishCalibration();
  }

  publish();
  state.procMs = performance.now() - t0;
}

/** Rough 1-sigma of a published position: the target's own error plus what DATUM contributes. */
function targetSigma(range: number, size: number, K: Intrinsics, posW: Vec3): number {
  const own = markerSigma(range, size, K.fx, CORNER_NOISE_PX);
  const lock = state.lock;
  let datumPart: number;
  if (lock) {
    datumPart = Math.hypot(lock.sigma, length(posW) * lock.angleSigma);
  } else {
    const d0 = state.originLive ? length(state.originLive.t) : range;
    const s0 = settings.size0 / 1000;
    datumPart = Math.hypot(markerSigma(d0, s0, K.fx, CORNER_NOISE_PX), length(posW) * ((CORNER_NOISE_PX * d0) / (K.fx * s0)));
  }
  return Math.hypot(own, datumPart);
}

/** Average the origin marker over the next LOCK_FRAMES sightings (waits if it is not in view yet). */
let lockPending = false;
function startLock(): void {
  state.lock = null;
  saveLock(settings.source, null);
  state.locking = [];
  lockPending = true;
}

function finishLock(K: Intrinsics, s0: number): void {
  const all = state.locking.splice(0);
  lockPending = false;
  // Robust: frames far from the median (someone walking past, a bad detection) are dropped.
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const m: Vec3 = [0, 1, 2].map((k) => med(all.map((p) => p.t[k]))) as Vec3;
  const d = all.map((p) => dist(p.t, m));
  const cut = Math.max(0.03, 3 * med(d));
  const poses = all.filter((_, i) => d[i] <= cut);
  const pose = averagePoses(poses);
  const d0 = length(pose.t);
  // spread of the kept samples, so a wobbly or half-hidden marker shows up as a larger sigma
  const spread = Math.sqrt(poses.reduce((s, p) => s + dist(p.t, pose.t) ** 2, 0) / poses.length);
  const sigma = Math.max(markerSigma(d0, s0, K.fx, CORNER_NOISE_PX), spread) / Math.sqrt(poses.length);
  const angleSigma = (CORNER_NOISE_PX * d0) / (K.fx * s0) / Math.sqrt(poses.length);
  const rejected = d.filter((v) => v > cut);
  state.lock = { pose, frames: poses.length, width: state.width, height: state.height, hfov: settings.hfov, sigma, angleSigma, rejected };
  saveLock(settings.source, state.lock);
}

// ---- FOV calibration from one tape-measured distance -------------------------------------------

function finishCalibration(): void {
  const cal = state.calibrating!;
  state.calibrating = null;
  const r = calibrateHfov(cal.samples, cal.trueDist, { origin: settings.size0 / 1000, target: settings.size1 / 1000 }, state.width, state.height);
  if (!r) {
    $('calState').textContent = 'Calibration failed: markers not solvable.';
    return;
  }
  setHfov(r.hfov);
  const weak = r.sigmaDeg > 3;
  $('calState').textContent =
    `FOV ${r.hfov.toFixed(1)} deg, plus or minus ${r.sigmaDeg.toFixed(1)}.` +
    (weak ? ' Weak: put the target further beyond the origin, straight away from the camera, and repeat.' : ' Lock DATUM again.');
  $('calState').className = weak ? 'warn' : 'ok';
}

// ---- publishing -------------------------------------------------------------------------------

let transport: WebSocketTransport | null = null;
let mesh: MeshNode | null = null;
let lastPublish = 0;

function connect(): void {
  transport?.close();
  transport = new WebSocketTransport({ url: settings.relayUrl, id: settings.nodeId });
  mesh = new MeshNode(transport, { ttl: 4, relay: true });
}

function publish(): void {
  if (!settings.publish || !mesh || !state.target) return;
  const now = Date.now();
  if (now - lastPublish < PUBLISH_MS) return;
  lastPublish = now;
  mesh.publish({ t: now, label: 'tag', id: `tag-${TARGET_ID}`, pos: state.target.pos, sigma: state.target.sigma });
}

// ---- drawing ----------------------------------------------------------------------------------

function draw(): void {
  const dpr = devicePixelRatio || 1;
  const cw = view.clientWidth;
  const ch = view.clientHeight;
  if (view.width !== Math.round(cw * dpr) || view.height !== Math.round(ch * dpr)) {
    view.width = Math.round(cw * dpr);
    view.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05080b';
  ctx.fillRect(0, 0, cw, ch);
  if (!state.width) {
    ctx.fillStyle = '#8593a3';
    ctx.fillText('Waiting for frames...', 20, 30);
    return;
  }
  const s = Math.min(cw / state.width, ch / state.height);
  const ox = (cw - state.width * s) / 2;
  const oy = (ch - state.height * s) / 2;
  ctx.drawImage(frameCanvas, ox, oy, state.width * s, state.height * s);
  const P = (p: Vec2): Vec2 => [ox + p[0] * s, oy + p[1] * s];
  const K = state.K!;
  const D = datum();

  // floor grid and axes of W, drawn through DATUM: if they sit right on the floor, DATUM is right
  if (D) {
    const toPx = (w: Vec3): Vec2 | null => {
      const c = worldToCamera(D, w);
      return c[2] > 0.05 ? P(projectCam(K, c)) : null;
    };
    const seg = (a: Vec3, b: Vec3, color: string, width: number) => {
      // split long lines so they bend correctly in perspective and clip behind the camera
      const n = 20;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i <= n; i++) {
        const p = toPx([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, a[2] + ((b[2] - a[2]) * i) / n]);
        if (!p) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
        pen = true;
      }
      ctx.stroke();
    };
    for (let i = -6; i <= 6; i++) {
      seg([i, 0, -8], [i, 0, 4], 'rgba(34, 211, 238, 0.28)', 1);
      seg([-6, 0, i - 2], [6, 0, i - 2], 'rgba(34, 211, 238, 0.28)', 1);
    }
    seg([0, 0, 0], [0.5, 0, 0], '#f87171', 3);
    seg([0, 0, 0], [0, 0.5, 0], '#4ade80', 3);
    seg([0, 0, 0], [0, 0, 0.5], '#60a5fa', 3);
  }

  // detected markers
  for (const d of state.detections) {
    const c = d.corners.map(P);
    ctx.strokeStyle = d.id === ORIGIN_ID ? '#facc15' : d.id === TARGET_ID ? '#22d3ee' : '#9ca3af';
    ctx.lineWidth = 2;
    ctx.beginPath();
    c.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(c[0][0], c[0][1], 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(d.id === ORIGIN_ID ? 'ORIGIN' : d.id === TARGET_ID ? 'TARGET' : `id ${d.id}`, c[0][0] + 6, c[0][1] - 6);
  }

  // test scene truth
  if (D && state.truth) {
    const c = worldToCamera(D, state.truth);
    if (c[2] > 0) {
      const p = P(projectCam(K, c));
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ---- panel ------------------------------------------------------------------------------------

const f2 = (v: number) => v.toFixed(2);
const cm = (v: number) => `${(v * 100).toFixed(1)} cm`;
const vec = (v: Vec3) => `${f2(v[0])}, ${f2(v[1])}, ${f2(v[2])}`;
const row = (k: string, v: string, cls = '') => `<div><span class="dim">${k}</span><b class="${cls}">${v}</b></div>`;

function panel(): void {
  $('hfovVal').textContent = `${settings.hfov.toFixed(1)} deg`;
  $('freezeRow').style.display = settings.source === TEST ? '' : 'none';
  const K = state.K;
  $('camInfo').innerHTML = state.width
    ? row('Frame', `${state.width} x ${state.height}, focal ${K ? K.fx.toFixed(0) : '?'} px`) +
      row('Processing', `${state.procMs.toFixed(0)} ms, ${state.fps.toFixed(1)} fps`)
    : '';

  const pill = $('datumState');
  const D = datum();
  if (lockPending) {
    pill.textContent = `locking ${state.locking.length}/${LOCK_FRAMES}`;
    pill.className = 'pill warn';
  } else if (state.lock) {
    pill.textContent = `locked (${state.lock.frames} frames${state.lock.rejected?.length ? `, ${state.lock.rejected.length} dropped` : ''})`;
    pill.className = 'pill ok';
  } else if (state.originLive) {
    pill.textContent = 'live, not locked';
    pill.className = 'pill warn';
  } else {
    pill.textContent = 'origin not seen';
    pill.className = 'pill bad';
  }
  if (D) {
    const cam = cameraToWorld(D, [0, 0, 0]);
    const ambiguous = !state.lock && state.originLive && state.originAltRms < state.originRms * 1.5;
    $('datumInfo').innerHTML =
      row('Camera in W', vec(cam)) +
      row('Camera height', `${f2(cam[1])} m`) +
      row('Origin distance', `${f2(length(D.t))} m`) +
      (state.lock ? row('DATUM sigma', `${cm(state.lock.sigma)}, ${((state.lock.angleSigma * 180) / Math.PI).toFixed(2)} deg`) : '') +
      (state.originLive ? row('Origin fit', `${state.originRms.toFixed(2)} px${ambiguous ? ' (ambiguous: tilt the camera more)' : ''}`, ambiguous ? 'warn' : '') : '');
  } else {
    $('datumInfo').innerHTML = '<div class="dim">Put the origin marker flat on the floor in view.</div>';
  }

  const T = state.target;
  if (T) {
    let html =
      row('Position in W', `${vec(T.pos)} m`) +
      row('Range from camera', `${f2(T.range)} m`) +
      row('Expected error (1 sigma)', cm(T.sigma)) +
      row('Pose', T.upright ? 'upright' : 'flat on the floor') +
      row('Corner fit', `${T.rms.toFixed(2)} px`);
    if (T.floor) html += row('Floor-ray estimate', `${vec(T.floor)} m`);
    if (state.truth) {
      const e = dist(T.pos, state.truth);
      html +=
        row('Truth (test scene)', `${vec(state.truth)} m`) +
        row('Actual error', cm(e), e < 0.1 ? 'ok' : 'warn') +
        row('True distance to origin', `${dist(state.truth, testOrigin.pos).toFixed(3)} m`);
    }
    $('targetInfo').innerHTML = html;
  } else {
    $('targetInfo').innerHTML = `<div class="dim">${datum() ? 'Target marker not seen.' : 'Needs DATUM first.'}</div>`;
  }

  if (transport && settings.publish) {
    const st = transport.status;
    $('netInfo').innerHTML =
      row('Relay', st, st === 'open' ? 'ok' : 'warn') +
      row('Neighbours', transport.neighbors().join(', ') || 'none') +
      row('Sent / dropped', `${transport.stats.sent} / ${transport.stats.dropped}`) +
      (transport.notice ? row('Note', transport.notice, 'warn') : '');
  } else {
    $('netInfo').innerHTML = '';
  }
}

// ---- controls ---------------------------------------------------------------------------------

const hfovInput = $<HTMLInputElement>('hfov');
function setHfov(v: number): void {
  settings.hfov = Math.round(v * 10) / 10;
  settings.hfovBySource[settings.source] = settings.hfov;
  hfovInput.value = String(settings.hfov);
  save();
}
hfovInput.value = String(settings.hfov);
hfovInput.addEventListener('input', () => setHfov(Number(hfovInput.value)));

for (const [id, key] of [
  ['size0', 'size0'],
  ['size1', 'size1'],
] as const) {
  const el = $<HTMLInputElement>(id);
  el.value = String(settings[key]);
  el.addEventListener('change', () => {
    settings[key] = Number(el.value) || settings[key];
    state.lock = null; // a different marker size changes the scale of everything
    saveLock(settings.source, null);
    save();
  });
}

sourceSel.addEventListener('change', () => useSource(sourceSel.value));
$<HTMLInputElement>('freeze').addEventListener('change', (e) => {
  frozenAt = (e.target as HTMLInputElement).checked ? performance.now() / 1000 : null;
});
$('lock').addEventListener('click', startLock);
$('unlock').addEventListener('click', () => {
  state.lock = null;
  state.locking = [];
  lockPending = false;
  saveLock(settings.source, null);
});
$('calibrate').addEventListener('click', () => {
  const d = Number($<HTMLInputElement>('calDist').value);
  if (!(d > 0.2)) {
    $('calState').textContent = 'Enter the measured distance first.';
    return;
  }
  state.calibrating = { trueDist: d, samples: [] };
  $('calState').className = 'dim';
  $('calState').textContent = 'Collecting 20 frames with both markers...';
});

const relayUrl = $<HTMLInputElement>('relayUrl');
const nodeId = $<HTMLInputElement>('nodeId');
const publishBox = $<HTMLInputElement>('publish');
relayUrl.value = settings.relayUrl;
nodeId.value = settings.nodeId;
publishBox.checked = settings.publish;
const netChanged = () => {
  settings.relayUrl = relayUrl.value.trim();
  settings.nodeId = nodeId.value.trim() || 'OBS';
  settings.publish = publishBox.checked;
  save();
  if (settings.publish) connect();
  else {
    transport?.close();
    transport = null;
    mesh = null;
  }
};
relayUrl.addEventListener('change', netChanged);
nodeId.addEventListener('change', netChanged);
publishBox.addEventListener('change', netChanged);

// ---- loop -------------------------------------------------------------------------------------

// A timer, not requestAnimationFrame: processing should keep going while the window is not painted.
let lastTick = performance.now();
function tick(): void {
  const now = performance.now();
  const img = grabFrame(now / 1000);
  if (img) process(img);
  const dt = now - lastTick;
  lastTick = now;
  state.fps = state.fps * 0.8 + (1000 / Math.max(dt, 1)) * 0.2;
  draw();
  panel();
  setTimeout(tick, Math.max(0, 66 - (performance.now() - now)));
}

listCameras().then(() => useSource(sourceSel.value)).then(() => {
  if (settings.publish) connect();
  tick();
});

window.addEventListener('beforeunload', () => transport?.close());

// Debug handle for the browser console: __obs.step() processes one frame right away.
const step = () => {
  const img = grabFrame(performance.now() / 1000);
  if (img) process(img);
};
(window as unknown as { __obs: unknown }).__obs = { state, settings, datum, step };
