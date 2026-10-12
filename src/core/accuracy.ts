import { add, dist, length, scale, sub } from './math';
import { toWorld } from './transform';
import type { Pose4, Vec3 } from './types';

/**
 * Scoring of estimates whose true position is known. The observer's recorded points, the viewer's tap
 * checks and the accuracy report (tools/accuracy.ts) all use these, so they agree on what CEP and sigma
 * ratio mean.
 */

/** One estimate of a target whose true position is known (W, metres). */
export interface AccuracyFrame {
  est: Vec3; // W, from the full marker pose
  truth: Vec3; // W
  sigma: number; // the observer's expected 1-sigma (3D) for this estimate, m
  range: number; // camera to target, m
  floor?: Vec3 | null; // W, floor-ray estimate (only when the target lies flat)
}

export interface AccuracyStats {
  n: number;
  cep50: number; // horizontal (XZ) radius around the truth holding 50% of the estimates, m
  cep95: number; // same for 95%
  rms2d: number; // horizontal RMS error
  rms3d: number;
  max2d: number;
  bias: Vec3; // mean of (est - truth)
  /**
   * RMS 3D distance of the estimates from their own mean (precision, not accuracy). Taken over the
   * errors (est - truth), so a target that moves between frames does not count as scatter.
   */
  spread: number;
  /** RMS of (3D error / expected sigma); about 1 when the error model is honest, above 1 when optimistic. NaN without any sigma > 0. */
  sigmaRatio: number;
}

export function horizontalError(est: Vec3, truth: Vec3): number {
  return Math.hypot(est[0] - truth[0], est[2] - truth[2]);
}

/** Quantile with linear interpolation between order statistics (the common "type 7"); q in [0, 1]. Does not mutate. NaN when empty. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const v = [...values].sort((a, b) => a - b);
  const h = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, v.length - 1);
  return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

const rms = (values: number[]): number => Math.sqrt(values.reduce((s, x) => s + x * x, 0) / values.length);

const meanVec = (vs: Vec3[]): Vec3 => scale(vs.reduce<Vec3>((s, v) => add(s, v), [0, 0, 0]), 1 / vs.length);

/**
 * Stats of the chosen estimate (default f => f.est; use f => f.floor for the floor ray). Frames where pick
 * returns null/undefined are skipped. Returns null when nothing is left. sigmaRatio ignores frames with sigma <= 0.
 */
export function accuracyStats(
  frames: AccuracyFrame[],
  pick: (f: AccuracyFrame) => Vec3 | null | undefined = (f) => f.est,
): AccuracyStats | null {
  const errs: Vec3[] = [];
  const ratios: number[] = [];
  for (const f of frames) {
    const p = pick(f);
    if (!p) continue;
    const e = sub(p, f.truth);
    errs.push(e);
    if (f.sigma > 0) ratios.push(length(e) / f.sigma);
  }
  if (!errs.length) return null;
  const h = errs.map((e) => Math.hypot(e[0], e[2]));
  const bias = meanVec(errs);
  return {
    n: errs.length,
    cep50: quantile(h, 0.5),
    cep95: quantile(h, 0.95),
    rms2d: rms(h),
    rms3d: rms(errs.map(length)),
    max2d: h.reduce((m, x) => Math.max(m, x), 0),
    bias,
    spread: rms(errs.map((e) => dist(e, bias))),
    sigmaRatio: ratios.length ? rms(ratios) : NaN,
  };
}

/**
 * Group frames by range into bins with the given upper edges in metres, e.g. [2, 3, 4, 5, 6, Infinity]. A bin
 * holds from <= range < to, the first one starts at 0, and ranges at or past the last edge are dropped. Empty
 * bins (after pick, as in accuracyStats) are omitted.
 */
export function statsByRange(
  frames: AccuracyFrame[],
  edges: number[],
  pick?: (f: AccuracyFrame) => Vec3 | null | undefined,
): { from: number; to: number; stats: AccuracyStats }[] {
  const sorted = [...edges].sort((a, b) => a - b);
  const out: { from: number; to: number; stats: AccuracyStats }[] = [];
  let from = 0;
  for (const to of sorted) {
    const stats = accuracyStats(frames.filter((f) => f.range >= from && f.range < to), pick);
    if (stats) out.push({ from, to, stats });
    from = to;
  }
  return out;
}

/** A viewer check: the phone tapped a point on the floor whose W position is known. */
export interface TapCheck {
  tappedW: Vec3;
  truthW: Vec3;
  dx: number;
  dz: number;
  err2d: number;
}

/**
 * align: the viewer's local-to-W Pose4 (see alignFromTwoPoints in transform.ts); tapLocal: the hit-test point
 * in the XR local frame; truthW: where that point really is in W. Only the horizontal error counts, since a
 * floor tap carries no useful height.
 */
export function checkTap(align: Pose4, tapLocal: Vec3, truthW: Vec3): TapCheck {
  const tappedW = toWorld(align, tapLocal);
  const dx = tappedW[0] - truthW[0];
  const dz = tappedW[2] - truthW[2];
  return { tappedW, truthW, dx, dz, err2d: Math.hypot(dx, dz) };
}
