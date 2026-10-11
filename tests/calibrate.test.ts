import { describe, expect, it } from 'vitest';
import { intrinsicsFromHfov } from '../src/core/camera';
import { dist } from '../src/core/math';
import type { Vec3 } from '../src/core/types';
import { MarkerDetector, ORIGIN_ID, TARGET_ID } from '../src/live/aruco';
import { calibrateHfov, type CalSample } from '../src/live/calibrate';
import { lookAtCamera, renderScene, type SceneMarker } from '../src/live/synthetic';

const W = 960;
const H = 540;
const TRUE_HFOV = 65;
const cam = lookAtCamera(intrinsicsFromHfov(W, H, TRUE_HFOV), W, H, [0, 1.1, 1.8], [0, 0, -1.2]);
const origin: SceneMarker = { id: ORIGIN_ID, size: 0.16, pos: [0, 0, 0], yaw: 0 };

const cache = new Map<string, CalSample[]>();

/** Detected corners from three noisy renders (each render takes about a second, so they are cached). */
function samples(targetPos: Vec3): CalSample[] {
  const key = targetPos.join(',');
  if (cache.has(key)) return cache.get(key)!;
  const target: SceneMarker = { id: TARGET_ID, size: 0.16, pos: targetPos, yaw: Math.atan2(cam.pos[0] - targetPos[0], cam.pos[2] - targetPos[2]), upright: true };
  const out: CalSample[] = [];
  for (let seed = 1; seed <= 3; seed++) {
    const img = { width: W, height: H, data: renderScene(cam, [origin, target], { samples: 2, noise: 3, seed }) };
    const found = new MarkerDetector().detect(img);
    const o = found.find((d) => d.id === ORIGIN_ID);
    const t = found.find((d) => d.id === TARGET_ID);
    if (o && t) out.push({ origin: o.corners, target: t.corners });
  }
  cache.set(key, out);
  return out;
}

describe('FOV calibration from a measured distance', () => {
  it('recovers the true FOV when the target is well beyond the origin', () => {
    const pos: Vec3 = [0.2, 0.4, -3.0];
    const s = samples(pos);
    expect(s.length).toBe(3);
    const r = calibrateHfov(s, dist(pos, origin.pos), { origin: 0.16, target: 0.16 }, W, H)!;
    expect(Math.abs(r.hfov - TRUE_HFOV)).toBeLessThan(1);
    // the reported uncertainty assumes 0.5 px corner noise, so it is on the cautious side
    expect(r.sigmaDeg).toBeLessThan(3);
  }, 30000);

  it('reports a weak result when the distance is mostly sideways', () => {
    const good = calibrateHfov(samples([0.2, 0.4, -3.0]), dist([0.2, 0.4, -3.0], [0, 0, 0]), { origin: 0.16, target: 0.16 }, W, H)!;
    const side: Vec3 = [1.0, 0.4, -0.6];
    const weak = calibrateHfov(samples(side), dist(side, origin.pos), { origin: 0.16, target: 0.16 }, W, H)!;
    expect(weak.sigmaDeg).toBeGreaterThan(2 * good.sigmaDeg);
  }, 30000);
});
