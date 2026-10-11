import { describe, expect, it } from 'vitest';
import {
  cameraToWorld,
  intrinsicsFromHfov,
  pixelToFloor,
  projectCam,
  quadCentre,
  solveSquarePose,
  squareCorners,
  transformPoint,
} from '../src/core/camera';
import { dist } from '../src/core/math';
import { MarkerDetector, ORIGIN_ID, TARGET_ID, markerGrid, markerSvg } from '../src/live/aruco';
import { lookAtCamera, renderScene, truePose, type SceneMarker } from '../src/live/synthetic';

const W = 960;
const H = 540;
const K = intrinsicsFromHfov(W, H, 65);

describe('marker sheets', () => {
  it('builds a 10 x 10 grid: white quiet zone, black border, 6 x 6 code', () => {
    const g = markerGrid(ORIGIN_ID);
    expect(g.length).toBe(10);
    expect(g[0].every(Boolean)).toBe(true);
    expect(g[1].slice(1, 9).some(Boolean)).toBe(false);
    expect(markerGrid(TARGET_ID)).not.toEqual(g);
    expect(markerSvg(0)).toContain('viewBox="0 0 10 10"');
  });
});

describe('detect and locate markers in a synthetic webcam frame', () => {
  const origin: SceneMarker = { id: ORIGIN_ID, size: 0.15, pos: [0, 0, 0], yaw: 0 };
  const target: SceneMarker = { id: TARGET_ID, size: 0.15, pos: [1.1, 0, -0.9], yaw: 0.6 };
  const cam = lookAtCamera(K, W, H, [-0.6, 1.2, 1.8], [0.4, 0, -0.3]);
  const img = { width: W, height: H, data: renderScene(cam, [origin, target], { samples: 2, noise: 3 }) };
  const found = new MarkerDetector().detect(img);

  it('finds both ids with no bit errors', () => {
    expect(found.map((d) => d.id).sort()).toEqual([ORIGIN_ID, TARGET_ID]);
    expect(found.every((d) => d.bitErrors === 0)).toBe(true);
  });

  it('returns corners in printed order (top-left first), refined to a fraction of a pixel', () => {
    const rough = new MarkerDetector(2, false).detect(img);
    for (const m of [origin, target]) {
      const truth = squareCorners(m.size).map((p) => projectCam(K, transformPoint(truePose(cam, m), p)));
      const err = (ds: typeof found) => {
        const det = ds.find((d) => d.id === m.id)!;
        return Math.max(...truth.map((t, i) => Math.hypot(det.corners[i][0] - t[0], det.corners[i][1] - t[1])));
      };
      expect(err(rough)).toBeLessThan(2.5);
      expect(err(found)).toBeLessThan(0.35);
    }
  });

  it('puts the camera and the target where they really are in W', () => {
    const o = solveSquarePose(found.find((d) => d.id === ORIGIN_ID)!.corners, origin.size, K)!;
    const tDet = found.find((d) => d.id === TARGET_ID)!;
    const t = solveSquarePose(tDet.corners, target.size, K)!;

    expect(dist(cameraToWorld(o.pose, [0, 0, 0]), cam.pos)).toBeLessThan(0.05);
    expect(dist(cameraToWorld(o.pose, t.pose.t), target.pos)).toBeLessThan(0.05);
    expect(dist(pixelToFloor(o.pose, K, quadCentre(tDet.corners))!, target.pos)).toBeLessThan(0.05);
  });
});
