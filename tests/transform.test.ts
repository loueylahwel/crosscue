import { describe, expect, it } from 'vitest';
import { dist } from '../src/core/math';
import { alignFromTwoPoints, composePose4, invertPose4, toLocal, toWorld } from '../src/core/transform';
import type { Pose4, Vec3 } from '../src/core/types';

const close = (a: Vec3, b: Vec3, eps = 1e-9) => expect(dist(a, b)).toBeLessThan(eps);

describe('toWorld / toLocal', () => {
  it('yaw 0 keeps axes, forward is -Z', () => {
    const pose: Pose4 = { pos: [10, 0, 5], yaw: 0 };
    close(toWorld(pose, [0, 0, -2]), [10, 0, 3]);
  });

  it('positive yaw turns left (counter-clockwise from above)', () => {
    const pose: Pose4 = { pos: [0, 0, 0], yaw: Math.PI / 2 };
    // 2 m straight ahead of an agent facing -X
    close(toWorld(pose, [0, 0, -2]), [-2, 0, 0]);
  });

  it('round-trips for any pose', () => {
    const pose: Pose4 = { pos: [3, 1, -4], yaw: 1.234 };
    const p: Vec3 = [0.5, 2, -7];
    close(toLocal(pose, toWorld(pose, p)), p);
  });
});

describe('the "north-west of A" problem', () => {
  it('two devices facing different ways agree on the same world point', () => {
    const target: Vec3 = [4, 1, -6]; // truth in W
    const a: Pose4 = { pos: [0, 0, 0], yaw: 0.3 };
    const b: Pose4 = { pos: [8, 0, 2], yaw: -2.0 };
    // A measures the target relative to itself and shares only the world-frame result.
    const relA = toLocal(a, target);
    const sharedW = toWorld(a, relA);
    // B converts that into its own view; the result must be where B would measure the truth.
    close(toLocal(b, sharedW), toLocal(b, target));
  });

  it('a wrong yaw estimate puts the shared point in the wrong place (1 deg ~ 9 cm at 5 m)', () => {
    const truthPose: Pose4 = { pos: [0, 0, 0], yaw: 0 };
    const estPose: Pose4 = { pos: [0, 0, 0], yaw: (1 * Math.PI) / 180 };
    const target: Vec3 = [0, 0, -5];
    const reported = toWorld(estPose, toLocal(truthPose, target));
    expect(dist(reported, target)).toBeCloseTo(0.0873, 3);
  });
});

describe('pose algebra', () => {
  it('invertPose4 undoes a pose', () => {
    const p: Pose4 = { pos: [1, 2, 3], yaw: 0.7 };
    const x: Vec3 = [4, -1, 2];
    close(toWorld(invertPose4(p), toWorld(p, x)), x);
  });

  it('composePose4(a, b) applies b first, then a', () => {
    const a: Pose4 = { pos: [1, 0, 0], yaw: 0.5 };
    const b: Pose4 = { pos: [0, 0, -2], yaw: -1.1 };
    const x: Vec3 = [0.3, 0.2, 0.9];
    close(toWorld(composePose4(a, b), x), toWorld(a, toWorld(b, x)));
  });
});

describe('alignFromTwoPoints (tap marker centre, then a point on its +X edge)', () => {
  it('maps the tapped origin to W origin and the second point onto the +X axis', () => {
    const originL: Vec3 = [1, 0.5, 2];
    const xL: Vec3 = [1, 0.5, 1]; // marker +X runs towards -Z in the phone's own frame
    const align = alignFromTwoPoints(originL, xL);
    close(toWorld(align, originL), [0, 0, 0]);
    close(toWorld(align, xL), [1, 0, 0]);
  });

  it('works for an arbitrary heading and keeps lengths', () => {
    const originL: Vec3 = [-3, 0, 4];
    const xL: Vec3 = [-3 + 2 * Math.cos(0.8), 0, 4 - 2 * Math.sin(0.8)];
    const align = alignFromTwoPoints(originL, xL);
    close(toWorld(align, xL), [2, 0, 0]);
    const other: Vec3 = [5, 1, 5];
    expect(dist(toWorld(align, other), toWorld(align, originL))).toBeCloseTo(dist(other, originL), 9);
  });

  it('rejects coincident points', () => {
    expect(() => alignFromTwoPoints([1, 0, 1], [1, 2, 1])).toThrow();
  });
});
