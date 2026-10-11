/// <reference types="webxr" />
import { postReport } from './report';

/**
 * Phone check: what does this browser support for an AR viewer?
 * Static probes run on load; the AR test needs a tap (a user gesture) to start a session.
 */

type Status = 'ok' | 'warn' | 'bad' | 'info';
interface Row {
  name: string;
  status: Status;
  detail: string;
}

// Raw camera access is not in @types/webxr yet.
interface XRCameraLike {
  width: number;
  height: number;
}
interface CameraBinding {
  getCameraImage(camera: XRCameraLike): WebGLTexture | null;
}

const FEATURES = ['hit-test', 'dom-overlay', 'depth-sensing', 'camera-access', 'anchors', 'local-floor', 'plane-detection', 'light-estimation'];
const TEST_MS = 6000;

const $ = (id: string) => document.getElementById(id)!;
const report: { static: Row[]; session: Row[]; device: Record<string, unknown> } = { static: [], session: [], device: {} };

function render(table: HTMLElement, rows: Row[]): void {
  table.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const label = { ok: 'yes', warn: 'partly', bad: 'no', info: '' }[r.status];
    tr.innerHTML = `<td>${r.name}</td><td class="${r.status}">${label}</td><td class="dim"></td>`;
    (tr.lastElementChild as HTMLElement).textContent = r.detail;
    table.appendChild(tr);
  }
}

async function staticChecks(): Promise<void> {
  const rows: Row[] = [];
  const add = (name: string, status: Status, detail = '') => rows.push({ name, status, detail });

  const uaData = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> } })
    .userAgentData;
  if (uaData) {
    try {
      const hi = await uaData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
      report.device = hi;
      const chrome = (hi.fullVersionList as { brand: string; version: string }[] | undefined)?.find((b) => /Chrom/.test(b.brand));
      add('Device', 'info', `${hi.model || 'unknown model'}, ${hi.platform ?? ''} ${hi.platformVersion ?? ''}, ${chrome ? `${chrome.brand} ${chrome.version}` : ''}`);
    } catch {
      /* not fatal */
    }
  }
  add('User agent', 'info', navigator.userAgent);
  add('Screen', 'info', `${screen.width} x ${screen.height} css px, dpr ${devicePixelRatio}`);
  add('Secure context', isSecureContext ? 'ok' : 'bad', isSecureContext ? '' : 'open it as http://localhost:5173 through adb reverse, or over HTTPS');
  add('WebGL2', document.createElement('canvas').getContext('webgl2') ? 'ok' : 'bad');
  add('getUserMedia (camera)', typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'ok' : 'bad', 'fallback for marker detection');

  const xr = navigator.xr;
  add('navigator.xr', xr ? 'ok' : 'bad', xr ? '' : 'no WebXR: use Chrome on Android with Google Play Services for AR');
  if (xr) {
    for (const mode of ['immersive-ar', 'immersive-vr', 'inline'] as XRSessionMode[]) {
      let ok = false;
      let note = '';
      try {
        ok = await xr.isSessionSupported(mode);
      } catch (e) {
        note = String(e);
      }
      add(`Session ${mode}`, ok ? 'ok' : mode === 'immersive-ar' ? 'bad' : 'info', note || (ok ? '' : 'not supported'));
    }
  }
  report.static = rows;
  render($('static'), rows);
  ($('start') as HTMLButtonElement).disabled = !xr;
}

async function arTest(): Promise<void> {
  const rows: Row[] = [];
  const add = (name: string, status: Status, detail = '') => rows.push({ name, status, detail });
  const xr = navigator.xr!;
  const overlay = $('overlay');

  let session: XRSession;
  try {
    session = await xr.requestSession('immersive-ar', {
      optionalFeatures: FEATURES,
      domOverlay: { root: overlay },
      depthSensing: { usagePreference: ['cpu-optimized', 'gpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
    } as XRSessionInit);
  } catch (e) {
    add('Start immersive-ar', 'bad', String(e));
    finish(rows);
    return;
  }
  add('Start immersive-ar', 'ok');
  overlay.style.display = 'block';

  const enabled = session.enabledFeatures;
  add('Enabled features', enabled ? 'info' : 'warn', enabled ? enabled.join(', ') : 'browser does not report enabledFeatures');
  for (const f of FEATURES) {
    if (enabled) add(`  ${f}`, enabled.includes(f) ? 'ok' : 'bad');
  }
  add('DOM overlay type', session.domOverlayState ? 'ok' : 'bad', session.domOverlayState?.type ?? 'none');
  add('Depth usage / format', session.depthUsage ? 'ok' : 'info', session.depthUsage ? `${session.depthUsage} / ${session.depthDataFormat}` : 'no depth');

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true }) as WebGL2RenderingContext;
  await gl.makeXRCompatible();
  const layer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: layer });

  const spaces: Partial<Record<XRReferenceSpaceType, XRReferenceSpace>> = {};
  for (const type of ['local', 'local-floor', 'unbounded', 'viewer'] as XRReferenceSpaceType[]) {
    try {
      spaces[type] = await session.requestReferenceSpace(type);
      add(`Reference space ${type}`, 'ok');
    } catch {
      add(`Reference space ${type}`, type === 'local' || type === 'viewer' ? 'bad' : 'info', 'unavailable');
    }
  }
  const local = spaces['local-floor'] ?? spaces.local;

  let hitSource: XRHitTestSource | undefined;
  if (spaces.viewer && session.requestHitTestSource) {
    try {
      hitSource = await session.requestHitTestSource({ space: spaces.viewer });
    } catch (e) {
      add('Hit-test source', 'bad', String(e));
    }
  }

  const Binding = (window as unknown as { XRWebGLBinding?: new (s: XRSession, g: WebGL2RenderingContext) => unknown }).XRWebGLBinding;
  const binding = Binding ? new Binding(session, gl) : undefined;

  const stats = {
    frames: 0,
    posed: 0,
    emulated: 0,
    hits: 0,
    firstHitY: NaN,
    camera: '' as string,
    cameraFrames: 0,
    cameraError: '',
    depth: '',
    depthError: '',
    anchor: 'not tried',
  };
  let anchorTried = false;
  const t0 = performance.now();

  await new Promise<void>((done) => {
    const end = () => session.end().catch(() => undefined);
    $('stop').onclick = end;
    session.addEventListener('end', () => done());
    const timer = setTimeout(end, TEST_MS);
    session.addEventListener('end', () => clearTimeout(timer));

    const onFrame = (_t: number, frame: XRFrame) => {
      session.requestAnimationFrame(onFrame);
      stats.frames++;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!local) return;

      const pose = frame.getViewerPose(local);
      if (pose) {
        stats.posed++;
        if (pose.emulatedPosition) stats.emulated++;
        for (const view of pose.views) {
          const cam = (view as XRView & { camera?: XRCameraLike }).camera;
          if (cam && binding && 'getCameraImage' in (binding as object)) {
            try {
              const tex = (binding as CameraBinding).getCameraImage(cam);
              if (tex) stats.cameraFrames++;
              stats.camera = `${cam.width} x ${cam.height}`;
            } catch (e) {
              stats.cameraError = String(e);
            }
          }
          if (session.depthUsage === 'cpu-optimized' && !stats.depth) {
            try {
              const d = frame.getDepthInformation(view);
              if (d) stats.depth = `${d.width} x ${d.height} (cpu), ${d.getDepthInMeters(0.5, 0.5).toFixed(2)} m at centre`;
            } catch (e) {
              stats.depthError = String(e);
            }
          }
        }
      }
      if (hitSource) {
        const hits = frame.getHitTestResults(hitSource);
        if (hits.length) {
          stats.hits++;
          if (Number.isNaN(stats.firstHitY)) stats.firstHitY = hits[0].getPose(local)?.transform.position.y ?? NaN;
        }
      }
      if (!anchorTried && pose && frame.createAnchor) {
        anchorTried = true;
        stats.anchor = 'pending';
        frame
          .createAnchor(new XRRigidTransform({ x: 0, y: 0, z: -0.5 }), local)
          .then(() => (stats.anchor = 'ok'))
          .catch((e) => (stats.anchor = `failed: ${e}`));
      }
      const left = Math.max(0, TEST_MS - (performance.now() - t0)) / 1000;
      $('live').textContent =
        `${left.toFixed(1)} s left | frames ${stats.frames} | tracked ${stats.posed} | floor hits ${stats.hits}` +
        (stats.camera ? ` | camera ${stats.camera}` : '');
    };
    session.requestAnimationFrame(onFrame);
  });
  overlay.style.display = 'none';

  const secs = (performance.now() - t0) / 1000;
  add('Frame rate', stats.frames / secs > 20 ? 'ok' : 'warn', `${(stats.frames / secs).toFixed(1)} fps over ${secs.toFixed(1)} s`);
  add('Tracking (viewer pose)', stats.posed > stats.frames / 2 ? 'ok' : stats.posed ? 'warn' : 'bad',
    `${stats.posed} of ${stats.frames} frames${stats.emulated ? `, ${stats.emulated} emulated` : ''}`);
  add('Hit test on floor', stats.hits ? 'ok' : hitSource ? 'warn' : 'bad',
    hitSource ? `${stats.hits} frames with a hit${Number.isNaN(stats.firstHitY) ? '' : `, first hit y ${stats.firstHitY.toFixed(2)} m`}` : 'no hit-test source');
  add('Camera image (camera-access)', stats.cameraFrames ? 'ok' : 'bad',
    stats.cameraFrames ? `${stats.camera}, ${stats.cameraFrames} frames` : stats.cameraError || 'no camera image in frames');
  add('Depth data', stats.depth ? 'ok' : 'info', stats.depth || stats.depthError || 'none (fine, not required)');
  add('Anchors', stats.anchor === 'ok' ? 'ok' : 'info', stats.anchor);
  finish(rows);
}

function finish(rows: Row[]): void {
  report.session = rows;
  render($('session'), rows);
  postReport('xrcheck', report).then((ok) => ($('sent').textContent = ok ? 'Report sent to the PC.' : 'Could not reach the PC.'));
}

$('start').addEventListener('click', () => {
  arTest().catch((e) => finish([...report.session, { name: 'AR test crashed', status: 'bad', detail: String(e) }]));
});
$('copy').addEventListener('click', () => {
  navigator.clipboard?.writeText(JSON.stringify(report, null, 2)).then(() => ($('sent').textContent = 'Copied.'));
});

staticChecks().then(() => postReport('xrcheck', { phase: 'static', ...report }));
