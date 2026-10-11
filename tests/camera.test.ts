import { describe, expect, it } from 'vitest';
import {
  averagePoses,
  cameraToWorld,
  fromColumns,
  intrinsicsFromHfov,
  markerSigma,
  pixelToFloor,
  quadCentre,
  mulMat3,
  projectCam,
  solveSquarePose,
  squareCorners,
  transformPoint,
  worldToCamera,
  type Intrinsics,
  type Mat3,
  type RigidPose,
  type Vec2,
} from '../src/core/camera';
import { cross, dist, gauss, mulberry32, scale, sub } from '../src/core/math';
import type { Vec3 } from '../src/core/types';

const K: Intrinsics = intrinsicsFromHfov(1280, 720, 65);

/** Marker frame (u, v, n) to W as a matrix: X = u, Y = n, Z = -v. */
const M: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];

const unit = (v: Vec3): Vec3 => scale(v, 1 / Math.hypot(...v));

/** World-to-camera rotation for a camera at `c` looking at `at` (OpenCV axes: x right, y down, z forward). */
function lookAt(c: Vec3, at: Vec3): Mat3 {
  const z = unit(sub(at, c));
  const x = unit(cross(z, [0, 1, 0]));
  const y = cross(z, x);
  return [...x, ...y, ...z] as Mat3;
}

/** Pose (in the camera) of a marker lying flat on the floor at W position `w` with heading `yaw`. */
function floorMarkerPose(Rcw: Mat3, c: Vec3, w: Vec3, yaw = 0): RigidPose {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const Ryaw: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const R = mulMat3(Rcw, mulMat3(Ryaw, M));
  const t = transformPoint({ R: Rcw, t: [0, 0, 0] }, sub(w, c));
  return { R, t };
}

function corners(pose: RigidPose, size: number, rng?: () => number, noisePx = 0): Vec2[] {
  return squareCorners(size).map((p) => {
    const q = projectCam(K, transformPoint(pose, p));
    return rng ? [q[0] + gauss(rng) * noisePx, q[1] + gauss(rng) * noisePx] : q;
  });
}

const maxAbsDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe('intrinsics', () => {
  it('derives the focal length from the horizontal field of view', () => {
    const k = intrinsicsFromHfov(1000, 600, 90);
    expect(k.fx).toBeCloseTo(500, 9);
    expect(k.cx).toBe(500);
    expect(k.cy).toBe(300);
  });
});

describe('solveSquarePose', () => {
  const cams: { c: Vec3; at: Vec3 }[] = [
    { c: [0, 1.2, 2.0], at: [0, 0, 0] },
    { c: [1.5, 0.9, 1.5], at: [0.2, 0, -0.3] },
    { c: [-2.5, 1.6, 0.5], at: [0, 0, 0] },
    { c: [0.1, 2.5, 0.05], at: [0, 0, 0] }, // almost straight down: the ambiguous case
  ];

  it('recovers the exact pose from noise-free corners', () => {
    for (const { c, at } of cams) {
      const Rcw = lookAt(c, at);
      const truth = floorMarkerPose(Rcw, c, [0, 0, 0], 0.4);
      const sol = solveSquarePose(corners(truth, 0.15), 0.15, K)!;
      expect(sol.rms).toBeLessThan(1e-6);
      expect(maxAbsDiff(sol.pose.t, truth.t)).toBeLessThan(1e-6);
      expect(maxAbsDiff(sol.pose.R, truth.R)).toBeLessThan(1e-5);
    }
  });

  it('noisy corners give errors in line with markerSigma', () => {
    const rng = mulberry32(7);
    for (const { c, at } of cams.slice(0, 3)) {
      const Rcw = lookAt(c, at);
      const truth = floorMarkerPose(Rcw, c, [0, 0, 0]);
      let sq = 0;
      const n = 200;
      for (let k = 0; k < n; k++) {
        const sol = solveSquarePose(corners(truth, 0.15, rng, 0.3), 0.15, K)!;
        sq += dist(sol.pose.t, truth.t) ** 2;
      }
      const rms = Math.sqrt(sq / n);
      const predicted = markerSigma(Math.hypot(...truth.t), 0.15, K.fx, 0.3);
      expect(rms).toBeGreaterThan(0.3 * predicted);
      expect(rms).toBeLessThan(2 * predicted);
    }
  });
});

describe('DATUM from the origin marker', () => {
  it('maps the camera centre and a second floor marker into W', () => {
    const c: Vec3 = [1.2, 1.1, 2.4];
    const Rcw = lookAt(c, [0.5, 0, 0]);
    const origin = floorMarkerPose(Rcw, c, [0, 0, 0]);
    const target = floorMarkerPose(Rcw, c, [1.4, 0, -0.6], 1.1);

    const o = solveSquarePose(corners(origin, 0.15), 0.15, K)!;
    const t = solveSquarePose(corners(target, 0.12), 0.12, K)!;

    expect(maxAbsDiff(cameraToWorld(o.pose, [0, 0, 0]), c)).toBeLessThan(1e-6);
    expect(maxAbsDiff(cameraToWorld(o.pose, t.pose.t), [1.4, 0, -0.6])).toBeLessThan(1e-6);
    expect(maxAbsDiff(worldToCamera(o.pose, [1.4, 0, -0.6]), t.pose.t)).toBeLessThan(1e-6);
  });

  it('the floor ray through the quad centre lands on the target marker', () => {
    const c: Vec3 = [-0.8, 1.3, 3.0];
    const Rcw = lookAt(c, [0.5, 0, 0]);
    const origin = floorMarkerPose(Rcw, c, [0, 0, 0]);
    const tc = corners(floorMarkerPose(Rcw, c, [2.1, 0, -1.7], 0.7), 0.12);
    const o = solveSquarePose(corners(origin, 0.15), 0.15, K)!;
    const hit = pixelToFloor(o.pose, K, quadCentre(tc))!;
    expect(maxAbsDiff(hit, [2.1, 0, -1.7])).toBeLessThan(1e-6);
    // a ray above the horizon never meets the floor
    expect(pixelToFloor(o.pose, K, [640, -5000])).toBeNull();
  });

  it('W axes follow the printed marker: +X to its right edge, -Z to its top edge', () => {
    const c: Vec3 = [0, 1.5, 1.5];
    const o = floorMarkerPose(lookAt(c, [0, 0, 0]), c, [0, 0, 0]);
    // The printed right-edge midpoint (u = +h) is at +X, the top-edge midpoint (v = +h) at -Z.
    const right = transformPoint(o, [0.075, 0, 0]);
    const top = transformPoint(o, [0, 0.075, 0]);
    expect(maxAbsDiff(cameraToWorld(o, right), [0.075, 0, 0])).toBeLessThan(1e-9);
    expect(maxAbsDiff(cameraToWorld(o, top), [0, 0, -0.075])).toBeLessThan(1e-9);
  });

  it('averaging identical poses changes nothing', () => {
    const c: Vec3 = [0.4, 1.2, 2];
    const p = floorMarkerPose(lookAt(c, [0, 0, 0]), c, [0, 0, 0], 0.3);
    const avg = averagePoses([p, p, p]);
    expect(maxAbsDiff(avg.R, p.R)).toBeLessThan(1e-12);
    expect(maxAbsDiff(avg.t, p.t)).toBeLessThan(1e-12);
    // and fromColumns / M agree with the documented axis mapping
    expect(fromColumns([1, 0, 0], [0, 0, -1], [0, 1, 0])).toEqual(M);
  });
});
