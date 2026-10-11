import { describe, expect, it } from 'vitest';
import { bearingTo, canSee, segmentBlocked, type AABB } from '../src/core/geometry';
import type { Pose4 } from '../src/core/types';

// One wall across x = 5, with a doorway gap between z = -1 and z = 1.
const wallNorth: AABB = { min: [4.9, 0, -10], max: [5.1, 3, -1] };
const wallSouth: AABB = { min: [4.9, 0, 1], max: [5.1, 3, 10] };
const walls = [wallNorth, wallSouth];
const sight = { fov: (90 * Math.PI) / 180, range: 20, eyeHeight: 1.6 };

describe('segmentBlocked', () => {
  it('blocks a segment crossing a wall, passes through the doorway', () => {
    expect(segmentBlocked([0, 1, -5], [10, 1, -5], walls)).toBe(true);
    expect(segmentBlocked([0, 1, 0], [10, 1, 0], walls)).toBe(false);
  });

  it('does not block a segment that ends before the wall', () => {
    expect(segmentBlocked([0, 1, -5], [4, 1, -5], walls)).toBe(false);
  });
});

describe('bearingTo', () => {
  it('is 0 straight ahead (-Z), positive to the right (+X)', () => {
    const p: Pose4 = { pos: [0, 0, 0], yaw: 0 };
    expect(bearingTo(p, [0, 0, -5])).toBeCloseTo(0);
    expect(bearingTo(p, [5, 0, -5])).toBeCloseTo(Math.PI / 4);
    expect(bearingTo(p, [-5, 0, -5])).toBeCloseTo(-Math.PI / 4);
  });
});

describe('canSee', () => {
  // Agent facing +X (yaw -90deg: forward is -Z rotated to +X).
  const facingEast: Pose4 = { pos: [0, 0, -5], yaw: -Math.PI / 2 };

  it('cannot see through the wall even in range and in FOV', () => {
    expect(canSee(facingEast, [8, 1, -5], sight, walls)).toBe(false);
  });

  it('sees the same target when nothing is in the way', () => {
    expect(canSee(facingEast, [4, 1, -5], sight, walls)).toBe(true);
  });

  it('cannot see behind itself or beyond range', () => {
    expect(canSee(facingEast, [-3, 1, -5], sight, [])).toBe(false);
    expect(canSee(facingEast, [30, 1, -5], sight, [])).toBe(false);
  });

  it('sees through the doorway', () => {
    const inDoorLine: Pose4 = { pos: [0, 0, 0], yaw: -Math.PI / 2 };
    expect(canSee(inDoorLine, [8, 1, 0], sight, walls)).toBe(true);
  });
});
