import { cross, dot, gauss, mulberry32, scale, sub } from '../core/math';
import { fromColumns, mulMat3, transformPoint, type Intrinsics, type Mat3, type RigidPose } from '../core/camera';
import type { Vec3 } from '../core/types';
import { blackCells, markerGrid } from './aruco';

/**
 * A synthetic camera image of printed markers in a room with a tiled floor, with known truth. Used
 * by the tests and by the observer's "test scene" source, so the whole chain (detection, pose,
 * DATUM) can be checked without a webcam. Pure: no DOM.
 */

export interface SceneMarker {
  id: number;
  size: number; // black square side, m
  pos: Vec3; // centre in W
  /**
   * Lying flat (default): rotation about +Y, 0 = printed top edge towards -Z.
   * Upright: the direction the printed face looks, 0 = towards +Z (facing a camera that looks along -Z).
   */
  yaw: number;
  /** Standing on edge (vertical, printed top edge up) instead of lying on the floor. */
  upright?: boolean;
}

export interface SyntheticCamera {
  K: Intrinsics;
  width: number;
  height: number;
  /** Camera centre in W. */
  pos: Vec3;
  /** World-to-camera rotation (OpenCV axes: x right, y down, z forward). */
  Rcw: Mat3;
}

/** Camera at `pos` (W) looking at `at` (W), horizon level. */
export function lookAtCamera(K: Intrinsics, width: number, height: number, pos: Vec3, at: Vec3): SyntheticCamera {
  const n = (v: Vec3): Vec3 => scale(v, 1 / Math.hypot(...v));
  const z = n(sub(at, pos));
  const x = n(cross(z, [0, 1, 0]));
  const y = cross(z, x);
  return { K, width, height, pos, Rcw: [...x, ...y, ...z] as Mat3 };
}

/** The marker's own axes in W: u (to its right edge), v (to its printed top), n (out of the paper). */
export function markerAxes(m: SceneMarker): { u: Vec3; v: Vec3; n: Vec3 } {
  const c = Math.cos(m.yaw);
  const s = Math.sin(m.yaw);
  if (m.upright) {
    const n: Vec3 = [s, 0, c];
    return { u: [c, 0, -s], v: [0, 1, 0], n };
  }
  return { u: [c, 0, -s], v: [-s, 0, -c], n: [0, 1, 0] };
}

/** True pose, in this camera, of a marker (what solveSquarePose should return). */
export function truePose(cam: SyntheticCamera, m: SceneMarker): RigidPose {
  const { u, v, n } = markerAxes(m);
  return { R: mulMat3(cam.Rcw, fromColumns(u, v, n)), t: transformPoint({ R: cam.Rcw, t: [0, 0, 0] }, sub(m.pos, cam.pos)) };
}

export interface RenderOptions {
  /** Samples per pixel along each axis (2 = 4 samples, smoother edges). */
  samples?: number;
  /** Gaussian grey-level noise, 0..255. */
  noise?: number;
  seed?: number;
}

/** Render to RGBA bytes, row-major from the top-left pixel. */
export function renderScene(cam: SyntheticCamera, markers: SceneMarker[], opts: RenderOptions = {}): Uint8ClampedArray<ArrayBuffer> {
  const { K, width, height, pos, Rcw } = cam;
  const ss = Math.max(1, Math.floor(opts.samples ?? 2));
  const rng = mulberry32(opts.seed ?? 1);
  const noise = opts.noise ?? 0;
  const planes = markers.map((m) => {
    const g = markerGrid(m.id);
    const cell = m.size / blackCells();
    return { m, g, cell, half: (g.length / 2) * cell, ...markerAxes(m) };
  });
  const out = new Uint8ClampedArray(width * height * 4);

  const shade = (px: number, py: number): number => {
    // camera ray -> W direction (Rcw transposed)
    const dc: Vec3 = [(px - K.cx) / K.fx, (py - K.cy) / K.fy, 1];
    const d: Vec3 = [
      Rcw[0] * dc[0] + Rcw[3] * dc[1] + Rcw[6] * dc[2],
      Rcw[1] * dc[0] + Rcw[4] * dc[1] + Rcw[7] * dc[2],
      Rcw[2] * dc[0] + Rcw[5] * dc[1] + Rcw[8] * dc[2],
    ];
    const kFloor = d[1] < -1e-9 ? -pos[1] / d[1] : Infinity;
    let best = Infinity;
    let value = 0;
    for (const p of planes) {
      const den = dot(p.n, d);
      if (Math.abs(den) < 1e-9) continue;
      const k = dot(p.n, sub(p.m.pos, pos)) / den;
      if (k <= 0 || k > best || k > kFloor + 1e-6) continue;
      const rel = sub([pos[0] + k * d[0], pos[1] + k * d[1], pos[2] + k * d[2]], p.m.pos);
      const col = Math.floor((dot(rel, p.u) + p.half) / p.cell);
      const row = Math.floor((p.half - dot(rel, p.v)) / p.cell);
      if (col < 0 || row < 0 || col >= p.g.length || row >= p.g.length) continue;
      best = k;
      value = den < 0 ? (p.g[row][col] ? 235 : 20) : 200; // the back of the sheet is plain
    }
    if (best < Infinity) return value;
    if (kFloor === Infinity) return 60; // above the horizon: a dim wall
    // floor: 0.5 m tiles in two greys
    const x = pos[0] + kFloor * d[0];
    const z = pos[2] + kFloor * d[2];
    return (Math.floor(x * 2) + Math.floor(z * 2)) & 1 ? 150 : 128;
  };

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let sum = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) sum += shade(px + (sx + 0.5) / ss, py + (sy + 0.5) / ss);
      let v = sum / (ss * ss);
      if (noise) v += gauss(rng) * noise;
      const i = (py * width + px) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}
