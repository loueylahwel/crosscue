import { describe, expect, it } from 'vitest';
import { accuracyStats, checkTap, horizontalError, quantile, statsByRange, type AccuracyFrame } from '../src/core/accuracy';
import { add } from '../src/core/math';
import { alignFromTwoPoints, toLocal } from '../src/core/transform';
import type { Pose4, Vec3 } from '../src/core/types';
import { formatReport } from '../tools/accuracy';

const frame = (truth: Vec3, err: Vec3, sigma = 0.02, range = 3, floor?: Vec3 | null): AccuracyFrame => ({
  est: add(truth, err),
  truth,
  sigma,
  range,
  floor,
});

/** n horizontal errors of the given radii, spread evenly around the circle. */
const ring = (radii: number[], truth: Vec3 = [1, 0, -3]): AccuracyFrame[] =>
  radii.map((r, i) => {
    const a = (2 * Math.PI * i) / radii.length;
    return frame(truth, [r * Math.cos(a), 0, r * Math.sin(a)]);
  });

describe('quantile', () => {
  it('a single value is every quantile', () => {
    expect(quantile([5], 0)).toBe(5);
    expect(quantile([5], 0.5)).toBe(5);
    expect(quantile([5], 1)).toBe(5);
  });

  it('interpolates linearly between two values', () => {
    expect(quantile([3, 1], 0)).toBe(1);
    expect(quantile([3, 1], 0.25)).toBeCloseTo(1.5, 12);
    expect(quantile([3, 1], 0.5)).toBeCloseTo(2, 12);
    expect(quantile([3, 1], 1)).toBe(3);
  });

  it('odd and even counts (type 7)', () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([3, 1, 2], 0.95)).toBeCloseTo(2.9, 12); // h = 1.9
    expect(quantile([4, 1, 3, 2], 0.5)).toBeCloseTo(2.5, 12); // h = 1.5
    expect(quantile([4, 1, 3, 2], 0.95)).toBeCloseTo(3.85, 12); // h = 2.85
  });

  it('does not mutate its input and is NaN when empty', () => {
    const v = [3, 1, 2];
    quantile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('accuracyStats', () => {
  it('ignores height in the horizontal error', () => {
    expect(horizontalError([3, 5, 4], [0, -2, 0])).toBeCloseTo(5, 12);
  });

  it('a ring of equal errors has CEP equal to its radius and no bias', () => {
    const s = accuracyStats(ring(Array(12).fill(0.05)))!;
    expect(s.n).toBe(12);
    expect(s.cep50).toBeCloseTo(0.05, 12);
    expect(s.cep95).toBeCloseTo(0.05, 12);
    expect(s.rms2d).toBeCloseTo(0.05, 12);
    expect(s.max2d).toBeCloseTo(0.05, 12);
    expect(Math.hypot(...s.bias)).toBeLessThan(1e-12);
    expect(s.spread).toBeCloseTo(0.05, 12);
  });

  it('CEP50 and CEP95 of radii 1 to 10 cm', () => {
    const s = accuracyStats(ring([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => c / 100)))!;
    expect(s.cep50).toBeCloseTo(0.055, 12);
    expect(s.cep95).toBeCloseTo(0.0955, 12); // h = 8.55
    expect(s.max2d).toBeCloseTo(0.1, 12);
  });

  it('a constant offset is all bias and no spread, even when the target moves', () => {
    const off: Vec3 = [0.03, 0.01, -0.04];
    const frames = [frame([0, 0, -2], off), frame([1, 0.5, -3], off), frame([-2, 0, -4], off)];
    const s = accuracyStats(frames)!;
    s.bias.forEach((b, i) => expect(b).toBeCloseTo(off[i], 12));
    expect(s.spread).toBeLessThan(1e-12);
    expect(s.cep50).toBeCloseTo(0.05, 12);
    expect(s.cep95).toBeCloseTo(0.05, 12);
    expect(s.rms2d).toBeCloseTo(0.05, 12);
    expect(s.rms3d).toBeCloseTo(Math.hypot(...off), 12);
  });

  it('sigma ratio is 1 when errors match sigma, 2 when sigma is half the error, and skips sigma <= 0', () => {
    const honest = [frame([0, 0, 0], [0.02, 0, 0], 0.02), frame([0, 0, 0], [0, 0.05, 0], 0.05), frame([0, 0, 0], [1, 0, 0], 0)];
    expect(accuracyStats(honest)!.sigmaRatio).toBeCloseTo(1, 12);
    const optimistic = [frame([0, 0, 0], [0.04, 0, 0], 0.02), frame([0, 0, 0], [0, 0, 0.1], 0.05)];
    expect(accuracyStats(optimistic)!.sigmaRatio).toBeCloseTo(2, 12);
    expect(accuracyStats([frame([0, 0, 0], [0.01, 0, 0], 0)])!.sigmaRatio).toBeNaN();
  });

  it('RMS, spread and sigma ratio of unequal errors are root mean squares, not plain means', () => {
    // 3D errors 3, 4 and 12 cm (the last one straight up) against sigmas 3, 2 and 4 cm: ratios 1, 2, 3
    const frames = [frame([0, 0, 0], [0.03, 0, 0], 0.03), frame([1, 0, -2], [0, 0, 0.04], 0.02), frame([0, 0, -4], [0, 0.12, 0], 0.04)];
    const s = accuracyStats(frames)!;
    expect(s.rms2d).toBeCloseTo(Math.sqrt(0.0025 / 3), 12);
    expect(s.rms3d).toBeCloseTo(Math.sqrt(0.0169 / 3), 12);
    expect(s.spread).toBeCloseTo(Math.sqrt(0.0169 / 3 - (0.01 ** 2 + 0.04 ** 2 + (0.04 / 3) ** 2)), 12);
    expect(s.sigmaRatio).toBeCloseTo(Math.sqrt(14 / 3), 12);
  });

  it('the floor pick skips frames without a floor estimate', () => {
    const frames = [
      frame([0, 0, -2], [0.01, 0, 0], 0.02, 2, [0.03, 0, -2]),
      frame([0, 0, -3], [0.01, 0, 0], 0.02, 3, null),
      frame([0, 0, -4], [0.01, 0, 0], 0.02, 4),
      frame([0, 0, -5], [0.01, 0, 0], 0.02, 5, [0, 0, -5.03]),
    ];
    const s = accuracyStats(frames, (f) => f.floor)!;
    expect(s.n).toBe(2);
    expect(s.cep50).toBeCloseTo(0.03, 12);
    expect(accuracyStats(frames.slice(1, 3), (f) => f.floor)).toBeNull();
  });

  it('is null without frames', () => {
    expect(accuracyStats([])).toBeNull();
  });
});

describe('statsByRange', () => {
  const frames = [1.5, 2, 2.5, 3.9, 7].map((r) => frame([0, 0, -r], [0.01, 0, 0], 0.02, r));

  it('bins by upper edge and omits empty bins', () => {
    const bins = statsByRange(frames, [2, 3, 4, 5, 6, Infinity]);
    expect(bins.map((b) => [b.from, b.to, b.stats.n])).toEqual([
      [0, 2, 1],
      [2, 3, 2],
      [3, 4, 1],
      [6, Infinity, 1],
    ]);
  });

  it('drops ranges past the last finite edge', () => {
    const bins = statsByRange(frames, [3, 6]);
    expect(bins.map((b) => b.stats.n)).toEqual([3, 1]);
  });
});

describe('checkTap', () => {
  // The phone's own tracking frame relative to W, unknown to the phone until it taps the origin marker.
  const trueAlign: Pose4 = { pos: [1.2, -0.3, 2.5], yaw: 0.8 };
  const align = alignFromTwoPoints(toLocal(trueAlign, [0, 0, 0]), toLocal(trueAlign, [0.08, 0, 0]));
  const truth: Vec3 = [1.5, 0, -2];

  it('a tap on the true point has no error after rotation and shift', () => {
    const c = checkTap(align, toLocal(trueAlign, truth), truth);
    expect(c.err2d).toBeLessThan(1e-9);
    c.tappedW.forEach((v, i) => expect(v).toBeCloseTo(truth[i], 9));
    expect(c.truthW).toEqual(truth);
  });

  it('a tap 3 cm along +X and 4 cm along -Z reports that offset in W', () => {
    const c = checkTap(align, toLocal(trueAlign, [truth[0] + 0.03, 0, truth[2] - 0.04]), truth);
    expect(c.dx).toBeCloseTo(0.03, 9);
    expect(c.dz).toBeCloseTo(-0.04, 9);
    expect(c.err2d).toBeCloseTo(0.05, 9);
  });
});

describe('formatReport', () => {
  const OLD = '2026-10-12T09:00:00.000Z';
  const NEW = '2026-10-12T10:30:00.000Z';
  const point = (session: string, label: string, truth: Vec3, err: Vec3, floor = false) =>
    JSON.stringify({
      event: 'point',
      at: session,
      session,
      label,
      source: 'webcam',
      hfov: 65,
      sizes: { origin: 0.16, target: 0.16 },
      datum: { locked: true, frames: 30, sigma: 0.004, angleSigma: 0.001 },
      truth,
      frames: [2.5, 3.5, 4.5].map((range) => ({
        est: add(truth, err),
        sigma: 0.02,
        range,
        rms: 0.3,
        upright: !floor,
        floor: floor ? add(truth, [0, 0, 0.02]) : null,
      })),
    });
  const check = (session: string, kind: string, err2d: number) =>
    JSON.stringify({ event: 'check', session, kind, label: 'x', truth: [0, 0, 0], tapped: [err2d, 0, 0], dx: err2d, dz: 0, err2d, trackSigma: null, hops: null });

  const lines = [
    point(OLD, 'P1', [0, 0, -3], [0.1, 0, 0]),
    '{not json',
    point(NEW, 'P1', [0, 0, -3], [0.03, 0, -0.04]),
    point(NEW, 'P2', [1, 0, -4], [0.03, 0, -0.04], true),
    JSON.stringify({ event: 'session-start', session: NEW }),
    '',
  ];
  const checkLines = [check(OLD, 'point', 0.2), check(NEW, 'point', 0.01), check(NEW, 'point', 0.03), check(NEW, 'target', 0.06)];
  /** Whitespace-split cells of the first line starting with `name`. */
  const cells = (text: string, name: string) => text.split('\n').find((l) => l.startsWith(name))?.slice(name.length).trim().split(/\s+/);

  it('reports only the latest session by default, with CEP values and a skipped-line count', () => {
    const text = formatReport(lines, { checkLines });
    expect(text).toContain(`Session ${NEW}`);
    expect(text).not.toContain(`Session ${OLD}`);
    expect(text).toContain('skipped 1 malformed line.');
    expect(text).toContain('2 points, 6 frames');
    expect(text).toContain('CEP50');
    expect(cells(text, 'full pose')?.slice(0, 3)).toEqual(['6', '5.0', '5.0']);
    expect(cells(text, 'floor ray')?.slice(0, 3)).toEqual(['3', '2.0', '2.0']);
    expect(cells(text, 'P1')).toEqual(['3', '3.50', '5.0', '0.0', '2.0']);
    expect(cells(text, '2-3')?.slice(0, 2)).toEqual(['2', '5.0']);
    expect(cells(text, '2-3')?.slice(-3)).toEqual(['1', '2.0', '2.0']); // floor n, CEP50, CEP95: only P2 lies flat
    expect(cells(text, 'all')?.slice(0, 2)).toEqual(['3', '3.0']); // viewer checks of the new session, CEP50 of 1, 3, 6 cm
    expect(text).toContain(`Viewer checks, session ${NEW}`);
    expect(text).not.toContain(`Viewer checks, session ${OLD}`);
  });

  it('--all prints every session, --session picks one', () => {
    const all = formatReport(lines, { all: true });
    expect(all.indexOf(`Session ${OLD}`)).toBeGreaterThanOrEqual(0);
    expect(all.indexOf(`Session ${NEW}`)).toBeGreaterThan(all.indexOf(`Session ${OLD}`));
    expect(cells(all, 'full pose')?.slice(0, 2)).toEqual(['3', '10.0']);

    const old = formatReport(lines, { session: OLD });
    expect(old).toContain(`Session ${OLD}`);
    expect(old).not.toContain(`Session ${NEW}`);
    expect(old).not.toContain('floor ray');
    expect(formatReport(lines, { session: 'nope' })).toContain('No recorded points for session nope');
  });

  it('drops a point named by an undo line, wherever the undo line sits', () => {
    const withId = (line: string, id: string) => JSON.stringify({ ...JSON.parse(line), id });
    const text = formatReport([
      JSON.stringify({ event: 'undo', session: NEW, id: 'bad', label: 'P1' }), // a small post can land before its point
      withId(point(NEW, 'P1', [0, 0, -3], [2, 0, 0]), 'bad'), // truth mistyped: 2 m off
      withId(point(NEW, 'P1', [0, 0, -3], [0.03, 0, -0.04]), 'good'),
    ]);
    expect(text).toContain('1 point, 3 frames');
    expect(cells(text, 'full pose')?.slice(0, 3)).toEqual(['3', '5.0', '5.0']);
  });

  it('the floor ray has no sigma ratio of its own', () => {
    expect(cells(formatReport(lines), 'floor ray')?.at(-1)).toBe('-');
  });

  it('a viewer check without err2d is scored from dx and dz', () => {
    const text = formatReport([], { checkLines: [JSON.stringify({ event: 'check', session: NEW, kind: 'point', dx: 0.03, dz: -0.04 })] });
    expect(text).not.toContain('skipped');
    expect(cells(text, 'point')).toEqual(['1', '5.0', '5.0', '5.0']);
  });
});
