import { intrinsicsFromHfov, markerSigma, solveSquarePose, type Vec2 } from '../core/camera';
import { dist, length } from '../core/math';

/**
 * Field-of-view calibration from one tape-measured distance between the origin and target marker
 * centres. Marker depth scales with the focal length while sideways offsets barely do, so the
 * answer is only sharp when the measured distance is mostly depth: target well beyond the origin,
 * roughly straight away from the camera. The result says how sharp it is.
 */

export interface CalSample {
  origin: Vec2[]; // corners, as detected
  target: Vec2[];
}

export interface CalResult {
  hfov: number; // degrees
  /** 1-sigma uncertainty of `hfov` from corner noise, degrees. Above about 1 the geometry is weak. */
  sigmaDeg: number;
  /** Mean measured distance at the chosen FOV minus the true one, metres. */
  residual: number;
}

export function calibrateHfov(
  samples: CalSample[],
  trueDist: number,
  sizes: { origin: number; target: number },
  width: number,
  height: number,
  noisePx = 0.5,
): CalResult | null {
  if (!samples.length) return null;
  const measured = (hfov: number) => {
    const K = intrinsicsFromHfov(width, height, hfov);
    let sum = 0;
    let n = 0;
    for (const s of samples) {
      const o = solveSquarePose(s.origin, sizes.origin, K);
      const t = solveSquarePose(s.target, sizes.target, K);
      if (!o || !t) continue;
      sum += dist(o.pose.t, t.pose.t);
      n++;
    }
    return n ? sum / n : NaN;
  };
  const cost = (hfov: number) => {
    const m = measured(hfov);
    return Number.isNaN(m) ? Infinity : (m - trueDist) ** 2;
  };

  // golden-section search
  let lo = 30;
  let hi = 120;
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo);
  let b = lo + g * (hi - lo);
  let fa = cost(a);
  let fb = cost(b);
  for (let i = 0; i < 40; i++) {
    if (fa < fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - g * (hi - lo);
      fa = cost(a);
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + g * (hi - lo);
      fb = cost(b);
    }
  }
  const hfov = (lo + hi) / 2;

  // sensitivity: how much the measured distance moves per degree, against how noisy it is
  const slope = (measured(hfov + 0.5) - measured(hfov - 0.5)) / 1; // metres per degree
  const K = intrinsicsFromHfov(width, height, hfov);
  const s = samples[0];
  const o = solveSquarePose(s.origin, sizes.origin, K);
  const t = solveSquarePose(s.target, sizes.target, K);
  const noise =
    o && t ? Math.hypot(markerSigma(length(o.pose.t), sizes.origin, K.fx, noisePx), markerSigma(length(t.pose.t), sizes.target, K.fx, noisePx)) : Infinity;
  const sigmaDeg = Math.abs(slope) > 1e-9 ? noise / Math.abs(slope) : Infinity;
  return { hfov, sigmaDeg, residual: measured(hfov) - trueDist };
}
