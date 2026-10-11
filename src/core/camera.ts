import { cross, dot, length, scale, sub } from './math';
import type { Vec3 } from './types';

/**
 * Pinhole camera maths for the FTX observer. Camera frame follows OpenCV: +x right, +y down,
 * +z forward (out of the lens). A square marker's own frame: u to its right-hand edge, v to its
 * printed top edge, n out of the paper; origin at the centre of the black square.
 */

export type Vec2 = [number, number];

/** Pinhole intrinsics in pixels. No lens distortion is modelled. */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Rigid transform from an object frame into the camera frame: p_cam = R p_obj + t. */
export interface RigidPose {
  R: Mat3;
  t: Vec3;
}

export interface SquarePose {
  pose: RigidPose;
  /** RMS reprojection error of the four corners, pixels. */
  rms: number;
  /** RMS of the other planar solution; close to `rms` means the orientation is ambiguous. */
  altRms: number;
}

/** Square-pixel intrinsics from the horizontal field of view, principal point at the image centre. */
export function intrinsicsFromHfov(width: number, height: number, hfovDeg: number): Intrinsics {
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2 };
}

// ---- small matrix helpers --------------------------------------------------------------------

export const mat3Identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const mulMat3Vec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** m transposed times v (m^T v), which is m^-1 v for a rotation. */
export const mulMat3TVec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export const fromColumns = (c0: Vec3, c1: Vec3, c2: Vec3): Mat3 => [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
export const column = (m: Mat3, j: number): Vec3 => [m[j], m[3 + j], m[6 + j]];

const normalize = (v: Vec3): Vec3 => scale(v, 1 / length(v));

/** Rotation by angle |w| about axis w (Rodrigues). */
export function rodrigues(w: Vec3): Mat3 {
  const th = length(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = scale(w, 1 / th);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

/**
 * Nearest rotation to the first two columns `a`, `b` (which should be roughly orthonormal):
 * split the error evenly between them, then complete with the cross product.
 */
export function orthonormalize(a: Vec3, b: Vec3): Mat3 {
  const an = normalize(a);
  const bn = normalize(b);
  const c = normalize([an[0] + bn[0], an[1] + bn[1], an[2] + bn[2]]);
  const d = normalize(sub(an, bn));
  const r1 = scale([c[0] + d[0], c[1] + d[1], c[2] + d[2]], Math.SQRT1_2);
  const r2 = scale(sub(c, d), Math.SQRT1_2);
  return fromColumns(r1, r2, cross(r1, r2));
}

/** Solve A x = b for a small dense system (Gaussian elimination, partial pivoting). */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ---- projection and pose ---------------------------------------------------------------------

/** Camera-frame point to pixel coordinates. */
export function projectCam(K: Intrinsics, p: Vec3): Vec2 {
  return [K.fx * (p[0] / p[2]) + K.cx, K.fy * (p[1] / p[2]) + K.cy];
}

export function transformPoint(pose: RigidPose, p: Vec3): Vec3 {
  const r = mulMat3Vec(pose.R, p);
  return [r[0] + pose.t[0], r[1] + pose.t[1], r[2] + pose.t[2]];
}

/** Corners of a square marker of side `size` (metres) in its own frame, as printed: TL, TR, BR, BL. */
export function squareCorners(size: number): Vec3[] {
  const h = size / 2;
  return [
    [-h, h, 0],
    [h, h, 0],
    [h, -h, 0],
    [-h, -h, 0],
  ];
}

function reprojectionRms(K: Intrinsics, pose: RigidPose, obj: Vec3[], img: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < obj.length; i++) {
    const p = transformPoint(pose, obj[i]);
    if (p[2] <= 0) return Infinity;
    const q = projectCam(K, p);
    s += (q[0] - img[i][0]) ** 2 + (q[1] - img[i][1]) ** 2;
  }
  return Math.sqrt(s / obj.length);
}

/** Planar homography (h33 = 1) taking marker-plane (u, v) to normalised image coordinates. */
function homography(plane: Vec2[], norm: Vec2[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = plane[i];
    const [x, y] = norm[i];
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]);
    b.push(x);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]);
    b.push(y);
  }
  const h = solveLinear(A, b);
  return h ? [...h, 1] : null;
}

/** Gauss-Newton on the pixel reprojection error, updating R on the left by small rotations. */
function refine(K: Intrinsics, start: RigidPose, obj: Vec3[], img: Vec2[], iterations = 12): RigidPose {
  let pose = start;
  const residuals = (p: RigidPose): number[] => {
    const out: number[] = [];
    for (let i = 0; i < obj.length; i++) {
      const q = projectCam(K, transformPoint(p, obj[i]));
      out.push(q[0] - img[i][0], q[1] - img[i][1]);
    }
    return out;
  };
  const apply = (p: RigidPose, d: number[]): RigidPose => ({
    R: mulMat3(rodrigues([d[0], d[1], d[2]]), p.R),
    t: [p.t[0] + d[3], p.t[1] + d[4], p.t[2] + d[5]],
  });
  let lambda = 1e-3;
  let r0 = residuals(pose);
  let cost = r0.reduce((s, v) => s + v * v, 0);
  for (let it = 0; it < iterations && cost > 1e-18; it++) {
    const J: number[][] = r0.map(() => new Array(6).fill(0));
    for (let k = 0; k < 6; k++) {
      const step = k < 3 ? 1e-6 : 1e-6 * Math.max(1, Math.abs(pose.t[2]));
      const d = new Array(6).fill(0);
      d[k] = step;
      const rp = residuals(apply(pose, d));
      for (let i = 0; i < r0.length; i++) J[i][k] = (rp[i] - r0[i]) / step;
    }
    const JtJ = [0, 1, 2, 3, 4, 5].map((a) => [0, 1, 2, 3, 4, 5].map((c) => J.reduce((s, row) => s + row[a] * row[c], 0)));
    const Jtr = [0, 1, 2, 3, 4, 5].map((a) => J.reduce((s, row, i) => s + row[a] * r0[i], 0));
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const d = solveLinear(A, Jtr.map((v) => -v));
      if (!d) break;
      const cand = apply(pose, d);
      const rc = residuals(cand);
      const cc = rc.reduce((s, v) => s + v * v, 0);
      if (cc < cost && cand.t[2] > 0) {
        pose = cand;
        r0 = rc;
        cost = cc;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
      } else {
        lambda *= 10;
      }
    }
    if (!improved) break;
  }
  return pose;
}

/**
 * Pose of a square marker from its four image corners (TL, TR, BR, BL as printed), its side
 * length in metres and the camera intrinsics. Planar targets have two near-mirror solutions when
 * seen face-on or from far away; both are refined and the one with the lower error wins.
 */
export function solveSquarePose(img: Vec2[], size: number, K: Intrinsics): SquarePose | null {
  const obj = squareCorners(size);
  const norm = img.map(([u, v]): Vec2 => [(u - K.cx) / K.fx, (v - K.cy) / K.fy]);
  const H = homography(
    obj.map((p): Vec2 => [p[0], p[1]]),
    norm,
  );
  if (!H) return null;
  const h1: Vec3 = [H[0], H[3], H[6]];
  const h2: Vec3 = [H[1], H[4], H[7]];
  const h3: Vec3 = [H[2], H[5], H[8]];
  let lambda = 2 / (length(h1) + length(h2));
  if (h3[2] * lambda < 0) lambda = -lambda; // the marker is in front of the camera
  const R = orthonormalize(scale(h1, lambda), scale(h2, lambda));
  const a = refine(K, { R, t: scale(h3, lambda) }, obj, img);

  // The mirror solution: reflect the marker normal about the line of sight to its centre.
  const v = normalize(a.t);
  const n = column(a.R, 2);
  const nb = sub(scale(v, 2 * dot(n, v)), n);
  const axis = cross(n, nb);
  const ang = Math.atan2(length(axis), dot(n, nb));
  const bStart: RigidPose = { R: length(axis) > 1e-9 ? mulMat3(rodrigues(scale(normalize(axis), ang)), a.R) : a.R, t: a.t };
  const b = refine(K, bStart, obj, img);

  const ra = reprojectionRms(K, a, obj, img);
  const rb = reprojectionRms(K, b, obj, img);
  return ra <= rb ? { pose: a, rms: ra, altRms: rb } : { pose: b, rms: rb, altRms: ra };
}

/**
 * Expected 1-sigma 3D error (metres) of a marker centre at `distance` metres, from corner noise of
 * `noisePx` pixels. Depth comes from the marker's apparent size, so it degrades with distance
 * squared; the sideways error only grows linearly. Ignores calibration error (wrong FOV).
 */
export function markerSigma(distance: number, size: number, focalPx: number, noisePx = 0.5): number {
  const depth = (distance * distance * noisePx) / (focalPx * size);
  const side = (distance * noisePx) / (2 * focalPx);
  return Math.sqrt(depth * depth + 2 * side * side);
}

// ---- DATUM: the origin marker defines the world frame W ---------------------------------------

/**
 * The origin marker lies flat on the floor. W's origin is its centre, +X its right-hand edge,
 * +Y up out of the paper, so +Z points to its printed BOTTOM edge (yaw 0 faces the printed top).
 */
export const markerToWorld = (p: Vec3): Vec3 => [p[0], p[2], -p[1]];
export const worldToMarker = (p: Vec3): Vec3 => [p[0], -p[2], p[1]];

/** A camera-frame point expressed in W, given the origin marker's pose in that camera. */
export function cameraToWorld(origin: RigidPose, pCam: Vec3): Vec3 {
  return markerToWorld(mulMat3TVec(origin.R, sub(pCam, origin.t)));
}

/** A W point expressed in the camera frame (inverse of cameraToWorld). */
export function worldToCamera(origin: RigidPose, pW: Vec3): Vec3 {
  return transformPoint(origin, worldToMarker(pW));
}

/** Where the diagonals of a quadrilateral (TL, TR, BR, BL) cross: the exact image of a square's centre. */
export function quadCentre(c: Vec2[]): Vec2 {
  const [p, q] = [c[0], c[2]];
  const [r, s] = [c[1], c[3]];
  const d1: Vec2 = [q[0] - p[0], q[1] - p[1]];
  const d2: Vec2 = [s[0] - r[0], s[1] - r[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const k = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / den;
  return [p[0] + k * d1[0], p[1] + k * d1[1]];
}

/**
 * Where the camera ray through pixel `px` meets the horizontal plane Y = `height` in W, or null if
 * the ray never reaches it. For things on the floor this avoids depth-from-size entirely.
 */
export function pixelToFloor(origin: RigidPose, K: Intrinsics, px: Vec2, height = 0): Vec3 | null {
  const from = cameraToWorld(origin, [0, 0, 0]);
  const dir = markerToWorld(mulMat3TVec(origin.R, [(px[0] - K.cx) / K.fx, (px[1] - K.cy) / K.fy, 1]));
  if (Math.abs(dir[1]) < 1e-9) return null;
  const k = (height - from[1]) / dir[1];
  if (k <= 0) return null;
  return [from[0] + k * dir[0], height, from[2] + k * dir[2]];
}

/** Mean of several poses of the same static marker (used to lock DATUM over many frames). */
export function averagePoses(poses: RigidPose[]): RigidPose {
  const t: Vec3 = [0, 0, 0];
  const c0: Vec3 = [0, 0, 0];
  const c1: Vec3 = [0, 0, 0];
  for (const p of poses) {
    for (let k = 0; k < 3; k++) {
      t[k] += p.t[k] / poses.length;
      c0[k] += p.R[k * 3];
      c1[k] += p.R[k * 3 + 1];
    }
  }
  return { R: orthonormalize(c0, c1), t };
}
