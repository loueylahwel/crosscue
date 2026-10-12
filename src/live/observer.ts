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
import { accuracyStats, type AccuracyFrame } from '../core/accuracy';
import { dist, length } from '../core/math';
import { MeshNode } from '../core/mesh';
import type { Vec3 } from '../core/types';
import { MarkerDetector, ORIGIN_ID, TARGET_ID, type Detection } from './aruco';
import { calibrateHfov, type CalSample } from './calibrate';
import { postReport } from './report';
import { loadSetting, saveSetting } from './settings';
import { lookAtCamera, renderScene, type SceneMarker } from './synthetic';
import { WebSocketTransport } from './wsTransport';

/**
 * FTX observer: a fixed webcam that sees the origin marker (DATUM) and the target marker, and
 * publishes the target's position in the shared world frame W over the relay. It also records
 * accuracy points: the target at a tape-measured spot, every estimate compared with that truth.
 */

const TEST = 'test';
const LOCK_FRAMES = 30;
const PUBLISH_MS = 100;
const CORNER_NOISE_PX = 0.5; // assumed corner noise for the error model
const NO_FIX_MS = 10_000; // a recording gives up after this long without a target fix
const MAX_PER_POINT = 1000;

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
  if (recorder.active && id !== settings.source) stopRecording('Aborted: the source changed.'); // a new camera may send no frames for a while
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

  recordFrame();
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

// ---- accuracy recorder ------------------------------------------------------------------------

/** One recorded frame: an AccuracyFrame plus the corner fit and pose, which help explain outliers. */
interface RecordedFrame extends AccuracyFrame {
  rms: number; // px
  upright: boolean;
}

/** One point as it is posted to /api/report/accuracy, so the page, the PC log and the download agree. */
interface PointLine {
  event: 'point';
  session: string;
  id: string; // the ISO time the point started; an undo line names the point by it
  label: string;
  source: 'test' | 'webcam';
  hfov: number;
  sizes: { origin: number; target: number }; // m
  datum: { locked: boolean; frames?: number; sigma?: number; angleSigma?: number };
  truth: Vec3 | null; // null in the test scene, where every frame carries its own truth
  frames: RecordedFrame[];
}

interface RecordedPoint {
  line: PointLine;
  stored: boolean | null; // whether the PC stored it; null while it has not answered
}

interface Recording {
  label: string;
  truth: Vec3 | null; // typed truth; null in the test scene, where each frame takes state.truth
  want: number;
  frames: RecordedFrame[];
  setup: Record<keyof typeof SETUP_NAMES, unknown>; // any change aborts the recording
  lock: DatumLock | null; // the DATUM lock it started with; any change aborts it too
  started: string; // ISO
  lastFix: number; // performance.now() of the last frame with a target fix
}

const SETUP_NAMES = { source: 'the source', hfov: 'the field of view', size0: 'the origin marker size', size1: 'the target marker size' };
const currentSetup = (): Recording['setup'] => ({ source: settings.source, hfov: settings.hfov, size0: settings.size0, size1: settings.size1 });

const accSettings = loadSetting('accuracy', { height: 0, perPoint: 30 });
const savedSession = loadSetting('accuracySession', { session: null as string | null, points: [] as RecordedPoint[] });

const recorder = {
  active: null as Recording | null,
  session: typeof savedSession.session === 'string' ? savedSession.session : null, // ISO start of the session's first point
  // a reload loses an unanswered post, so those count as not stored
  points: (Array.isArray(savedSession.points) ? savedSession.points : [])
    .filter((p) => typeof p?.line?.label === 'string' && Array.isArray(p.line.frames) && p.line.frames.length > 0)
    .map((p) => ({ line: p.line, stored: p.stored === true })) as RecordedPoint[],
  message: '',
  messageClass: 'dim',
};
const saveSession = () => saveSetting('accuracySession', { session: recorder.session, points: recorder.points });

const r5 = (v: number) => Math.round(v * 1e5) / 1e5; // 0.01 mm keeps the log readable
const r5v = (v: Vec3): Vec3 => [r5(v[0]), r5(v[1]), r5(v[2])];
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** The first unused label of the form P1, P2, ... */
function nextLabel(): string {
  const used = recorder.points.map((p) => Number(/^P(\d+)$/i.exec(p.line.label)?.[1] ?? 0));
  return `P${Math.max(0, ...used) + 1}`;
}

function say(message: string, cls = 'dim'): void {
  recorder.message = message;
  recorder.messageClass = cls;
}

function refuse(message: string): false {
  say(message, 'warn');
  return false;
}

/**
 * Start collecting the next n processed frames that have a target fix. Needs DATUM; without a lock the
 * point is still recorded, but marked. Returns false (with the reason in recorder.message) when it cannot start.
 */
function startRecording(n = accSettings.perPoint): boolean {
  if (recorder.active) return refuse('Already recording.');
  if (lockPending) return refuse('Wait for the DATUM lock to finish.');
  if (!datum()) return refuse('Needs DATUM first: put the origin marker in view.');
  const source = settings.source === TEST ? 'test' : 'webcam';
  if (recorder.points.some((p) => p.line.source !== source)) return refuse('This session has points from another source: press New session first.');
  let truth: Vec3 | null = null;
  if (settings.source !== TEST) {
    const [x, y, z] = [accX.valueAsNumber, accY.valueAsNumber, accZ.valueAsNumber];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return refuse('Type the measured X and Z first (metres).');
    if (!Number.isFinite(y)) return refuse('Type the height Y (0 when the target lies flat).');
    if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 30) return refuse('Over 30 m from the origin: type metres, not centimetres.');
    // an upright marker's centre is at least half its side above the floor; Y 0 means it was not typed
    if (state.target?.upright && y < settings.size1 / 2000) return refuse('The target stands upright: type the height of its centre (Y).');
    truth = [x, y, z];
  }
  recorder.active = {
    label: accLabel.value.trim() || nextLabel(),
    truth,
    want: Math.min(MAX_PER_POINT, Math.max(1, Math.round(n) || 1)),
    frames: [],
    setup: currentSetup(),
    lock: state.lock,
    started: new Date().toISOString(),
    lastFix: performance.now(),
  };
  if (state.lock) say('');
  else say('DATUM not locked: the point is recorded anyway and marked. Lock DATUM for a real run.', 'warn');
  return true;
}

function stopRecording(message: string, cls = 'bad'): void {
  recorder.active = null;
  say(message, cls);
}

/** Called for every processed frame: adds it to the point being recorded, or aborts the recording. */
function recordFrame(): void {
  const rec = recorder.active;
  if (!rec) return;
  const setup = currentSetup();
  const changed = (Object.keys(SETUP_NAMES) as (keyof typeof SETUP_NAMES)[]).find((k) => setup[k] !== rec.setup[k]);
  if (changed) return stopRecording(`Aborted: ${SETUP_NAMES[changed]} changed.`);
  if (!datum()) return stopRecording('Aborted: DATUM lost (origin marker not seen).');
  if (state.lock !== rec.lock) return stopRecording('Aborted: DATUM was locked, unlocked or reset.');
  const now = performance.now();
  const T = state.target;
  const truth = rec.truth ?? state.truth;
  if (!T || !truth) {
    if (now - rec.lastFix > NO_FIX_MS) stopRecording(`Aborted: target not seen for ${NO_FIX_MS / 1000} s.`);
    return;
  }
  rec.lastFix = now;
  rec.frames.push({
    est: r5v(T.pos),
    truth: r5v(truth),
    sigma: r5(T.sigma),
    range: r5(T.range),
    floor: T.floor ? r5v(T.floor) : null,
    rms: r5(T.rms),
    upright: T.upright,
  });
  if (rec.frames.length >= rec.want) finishPoint(rec);
}

/** A point is complete: keep it for the session and send it to the PC. */
function finishPoint(rec: Recording): void {
  recorder.active = null;
  recorder.session ??= rec.started;
  const lock = rec.lock;
  const point: RecordedPoint = {
    line: {
      event: 'point',
      session: recorder.session,
      id: rec.started,
      label: rec.label,
      source: rec.setup.source === TEST ? 'test' : 'webcam',
      hfov: settings.hfov,
      sizes: { origin: settings.size0 / 1000, target: settings.size1 / 1000 },
      datum: lock ? { locked: true, frames: lock.frames, sigma: lock.sigma, angleSigma: lock.angleSigma } : { locked: false },
      truth: rec.truth,
      frames: rec.frames,
    },
    stored: null,
  };
  recorder.points.push(point);
  saveSession();
  accLabel.value = nextLabel();
  accX.value = ''; // the next point is a new spot: its truth has to be typed again
  accZ.value = '';
  say(`${rec.label}: ${rec.frames.length} frames. Sending to the PC...`);
  renderPoints();
  postReport('accuracy', point.line).then((ok) => {
    point.stored = ok;
    saveSession();
    renderPoints();
    if (!recorder.active) {
      if (ok) say(`${rec.label} stored on the PC.`, 'ok');
      else say(`${rec.label} not stored: the PC did not answer. Download JSON keeps it.`, 'warn');
    }
  });
}

/** Remove the last point and put its label and truth back in the inputs, ready to record it again. */
function undoPoint(): void {
  const p = recorder.points.pop();
  if (!p) return;
  saveSession();
  accLabel.value = p.line.label;
  if (p.line.truth) [accX.value, accY.value, accZ.value] = p.line.truth.map(String);
  // the PC log is append-only, so it gets a line naming the withdrawn point (harmless if it never arrived)
  postReport('accuracy', { event: 'undo', session: p.line.session, id: p.line.id, label: p.line.label });
  say(`Removed ${p.line.label}.`);
  renderPoints();
}

function newSession(): void {
  if (recorder.points.some((p) => !p.stored) && !confirm('Some points are not stored on the PC. Clear them anyway?')) return;
  recorder.active = null;
  recorder.session = null; // the next point starts a new session id
  recorder.points = [];
  saveSession();
  accLabel.value = nextLabel();
  say('New session.');
  renderPoints();
}

/** Every point of the session, one per line like the PC's accuracy.jsonl, so `npm run accuracy -- <file>` reads it. */
function downloadSession(): void {
  if (!recorder.points.length || !recorder.session) return;
  const text = recorder.points.map((p) => `${JSON.stringify(p.line)}\n`).join('');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  a.download = `crosscue-accuracy-${recorder.session.replace(/\D+/g, '-').replace(/^-|-$/g, '')}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The session's points and a summary over all their frames. Only redrawn when the list changes. */
function renderPoints(): void {
  const pts = recorder.points;
  if (!pts.length) {
    $('accPoints').innerHTML = '<div class="dim">No points in this session yet.</div>';
    return;
  }
  const body = pts
    .map((p) => {
      const fr = p.line.frames;
      const s = accuracyStats(fr)!;
      const notes =
        (p.line.datum.locked ? '' : '<br><span class="warn">DATUM not locked</span>') +
        (p.stored === false ? '<br><span class="warn">not on the PC</span>' : p.stored === null ? '<br><span class="dim">sending</span>' : '');
      return (
        `<tr><td>${esc(p.line.label)}${notes}</td><td>${f2(mean(fr.map((f) => f.range)))} m</td><td>${s.n}</td>` +
        `<td>${cm(Math.hypot(s.bias[0], s.bias[2]))}</td><td>${cm(s.spread)}</td><td>${cm(mean(fr.map((f) => f.sigma)))}</td></tr>`
      );
    })
    .join('');
  const all = pts.flatMap((p) => p.line.frames);
  const s = accuracyStats(all)!;
  const floor = accuracyStats(all, (f) => f.floor);
  const stored = pts.filter((p) => p.stored).length;
  $('accPoints').innerHTML =
    '<table><thead><tr><th>Point</th><th>Range</th><th>n</th>' +
    '<th title="Horizontal error of the mean estimate">Error</th>' +
    '<th title="RMS scatter of the estimates around their mean">Spread</th>' +
    '<th title="Mean expected error (1 sigma)">Sigma</th></tr></thead>' +
    `<tbody>${body}</tbody></table>` +
    row('Session', recorder.session ? new Date(recorder.session).toLocaleString() : '-') +
    row('Points, frames', `${pts.length}, ${all.length}`) +
    row('CEP50', cm(s.cep50)) +
    row('CEP95', cm(s.cep95)) +
    row('RMS 3D', cm(s.rms3d)) +
    row('Sigma ratio', Number.isFinite(s.sigmaRatio) ? s.sigmaRatio.toFixed(2) : '-', s.sigmaRatio > 1.5 ? 'warn' : s.sigmaRatio > 0 ? 'ok' : '') +
    (floor ? row('Floor ray CEP50', cm(floor.cep50)) + row('Floor ray CEP95', cm(floor.cep95)) : '') +
    row('Stored on the PC', `${stored} of ${pts.length}`, stored === pts.length ? 'ok' : 'warn');
}

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

  const test = settings.source === TEST;
  accTruthEls.forEach((el) => (el.style.display = test ? 'none' : ''));
  $('accTest').style.display = test ? '' : 'none';
  const rec = recorder.active;
  const accState = $('accState');
  if (rec) {
    accState.textContent = `Recording ${rec.frames.length}/${rec.want}${rec.lock ? '' : ', DATUM not locked'}`;
    accState.className = rec.lock ? '' : 'warn';
  } else {
    accState.textContent = recorder.message;
    accState.className = recorder.messageClass;
  }
  $<HTMLButtonElement>('accRecord').disabled = !!rec || lockPending;
  $('accCancel').style.display = rec ? '' : 'none';
  $<HTMLButtonElement>('accUndo').disabled = !!rec || !recorder.points.length;
  $<HTMLButtonElement>('accNew').disabled = !!rec || (!recorder.points.length && !recorder.session);
  $<HTMLButtonElement>('accDownload').disabled = !recorder.points.length;

  if (transport && settings.publish) {
    const st = transport.status;
    $('netInfo').innerHTML =
      row('Relay', st, st === 'open' ? 'ok' : 'warn') +
      row('Neighbours', esc(transport.neighbors().join(', ')) || 'none') +
      row('Sent / dropped', `${transport.stats.sent} / ${transport.stats.dropped}`) +
      (transport.notice ? row('Note', esc(transport.notice), 'warn') : ''); // the notice quotes the typed relay URL
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

const accLabel = $<HTMLInputElement>('accLabel');
const accX = $<HTMLInputElement>('accX');
const accZ = $<HTMLInputElement>('accZ');
const accY = $<HTMLInputElement>('accY');
const accN = $<HTMLInputElement>('accN');
const accTruthEls = [...document.querySelectorAll<HTMLElement>('.acc-truth')];
accLabel.value = nextLabel();
accY.value = String(accSettings.height);
accN.value = String(accSettings.perPoint);
accY.addEventListener('change', () => {
  if (!Number.isFinite(accY.valueAsNumber)) return;
  accSettings.height = accY.valueAsNumber;
  saveSetting('accuracy', accSettings);
});
accN.addEventListener('change', () => {
  const n = Math.round(accN.valueAsNumber);
  if (n >= 1) accSettings.perPoint = Math.min(MAX_PER_POINT, n);
  accN.value = String(accSettings.perPoint);
  saveSetting('accuracy', accSettings);
});
$('accRecord').addEventListener('click', () => startRecording());
$('accCancel').addEventListener('click', () => stopRecording('Cancelled.', 'dim'));
$('accUndo').addEventListener('click', undoPoint);
$('accNew').addEventListener('click', newSession);
$('accDownload').addEventListener('click', downloadSession);
renderPoints();

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

// Debug handle for the browser console: __obs.step() processes one frame right away, and
// __obs.record(5) followed by five steps records a point in the test scene synchronously.
const step = () => {
  const img = grabFrame(performance.now() / 1000);
  if (img) process(img);
};
const record = (n?: number) => startRecording(n);
const cancel = () => stopRecording('Cancelled.', 'dim');
(window as unknown as { __obs: unknown }).__obs = { state, settings, datum, step, recorder, record, cancel };
