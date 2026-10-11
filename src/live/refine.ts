import type { Vec2 } from '../core/camera';
import type { ImageLike } from '../vendor/js-aruco2/aruco.js';

/**
 * Sub-pixel corner refinement for a detected marker. The detector's corners sit on whole contour
 * pixels (about 1 px off); here each of the four edges is re-measured along its normal at the
 * strongest brightness gradient, a straight line is fitted through those points, and the corners
 * become the intersections of neighbouring lines.
 *
 * Input corners are whole pixel indices as the detector gives them. Output is in continuous image
 * coordinates, where pixel (i, j) covers [i, i+1) x [j, j+1) and its centre is (i + 0.5, j + 0.5):
 * the convention the camera intrinsics use. If an edge cannot be measured the input is returned,
 * shifted to that convention.
 */
export function refineQuad(img: ImageLike, quad: Vec2[], opts: { samples?: number; search?: number } = {}): Vec2[] {
  const samples = opts.samples ?? 24;
  const { width, height, data } = img;

  const grey = (x: number, y: number): number => {
    // bilinear on pixel centres
    const fx = x - 0.5;
    const fy = y - 0.5;
    const x0 = Math.max(0, Math.min(width - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(height - 2, Math.floor(fy)));
    const ax = Math.min(1, Math.max(0, fx - x0));
    const ay = Math.min(1, Math.max(0, fy - y0));
    const at = (xx: number, yy: number) => {
      const i = (yy * width + xx) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    };
    const top = at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax;
    const bot = at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax;
    return top * (1 - ay) + bot * ay;
  };

  const q = quad.map(([x, y]): Vec2 => [x + 0.5, y + 0.5]);
  const mid: Vec2 = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
  const perimeter = q.reduce((s, p, i) => s + Math.hypot(q[(i + 1) % 4][0] - p[0], q[(i + 1) % 4][1] - p[1]), 0);
  // Stay well inside one cell (8 across the black square) so the code's own edges are out of reach.
  const search = opts.search ?? Math.min(3, Math.max(1, (perimeter / 32) * 0.6));
  const lines: { p: Vec2; d: Vec2 }[] = [];

  for (let e = 0; e < 4; e++) {
    const a = q[e];
    const b = q[(e + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 4) return q;
    const dir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let nrm: Vec2 = [-dir[1], dir[0]];
    // make the normal point into the marker
    if (nrm[0] * (mid[0] - (a[0] + b[0]) / 2) + nrm[1] * (mid[1] - (a[1] + b[1]) / 2) < 0) nrm = [-nrm[0], -nrm[1]];
    const pts: Vec2[] = [];
    for (let k = 0; k < samples; k++) {
      const t = 0.12 + (0.76 * k) / (samples - 1);
      const c: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      // brightness drop going inwards (white margin outside, black border inside), quarter-pixel steps
      const steps = Math.round(search * 4);
      let bestI = -1;
      let best = 0;
      const g: number[] = [];
      for (let i = -steps; i <= steps; i++) {
        const s = i / 4;
        const v1 = grey(c[0] + nrm[0] * (s + 0.5), c[1] + nrm[1] * (s + 0.5));
        const v0 = grey(c[0] + nrm[0] * (s - 0.5), c[1] + nrm[1] * (s - 0.5));
        const gi = v0 - v1;
        g.push(gi);
        if (gi > best) {
          best = gi;
          bestI = g.length - 1;
        }
      }
      if (bestI <= 0 || bestI >= g.length - 1 || best < 8) continue;
      // parabola through the peak and its neighbours
      const den = g[bestI - 1] - 2 * g[bestI] + g[bestI + 1];
      const off = den !== 0 ? (0.5 * (g[bestI - 1] - g[bestI + 1])) / den : 0;
      const s = (bestI - steps + off) / 4;
      pts.push([c[0] + nrm[0] * s, c[1] + nrm[1] * s]);
    }
    if (pts.length < 5) return q;
    lines.push(fitLine(pts));
  }

  const out: Vec2[] = [];
  for (let i = 0; i < 4; i++) {
    // corner i joins edge (i-1) and edge i
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p || Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > search + 2) return q;
    out.push(p);
  }
  return out;
}

/** Total least squares line through points: centroid plus principal direction. */
function fitLine(pts: Vec2[]): { p: Vec2; d: Vec2 } {
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x / pts.length;
    my += y / pts.length;
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] };
}

function intersect(l1: { p: Vec2; d: Vec2 }, l2: { p: Vec2; d: Vec2 }): Vec2 | null {
  const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
  if (Math.abs(den) < 1e-9) return null;
  const k = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den;
  return [l1.p[0] + k * l1.d[0], l1.p[1] + k * l1.d[1]];
}
