import type { AABB } from '../core/geometry';
import type { Vec3 } from '../core/types';

/**
 * A small house, 24 m x 14 m, four rooms. Coordinates are the shared world frame W (metres, +Y up).
 *
 *   z=0   +-------------+-------------+------+------+
 *         |             |             |  C          |
 *         |      A      |      B      +--  --+      |
 *         |             |             |  D          |
 *   z=14  +-------------+-------------+-------------+
 *        x=0           x=8          x=16          x=24
 *
 * Doors: A|B at z 6..8, B|C at z 3..5, C|D at x 19..21.
 */
export const MAP = { width: 24, depth: 14, wallHeight: 3, wallThickness: 0.2 };

function wall(x1: number, z1: number, x2: number, z2: number): AABB {
  const t = MAP.wallThickness / 2;
  const h = MAP.wallHeight;
  const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)];
  return xa === xb
    ? { min: [xa - t, 0, za - t], max: [xa + t, h, zb + t] }
    : { min: [xa - t, 0, za - t], max: [xb + t, h, zb + t] };
}

export const walls: AABB[] = [
  // outer shell
  wall(0, 0, 24, 0),
  wall(0, 14, 24, 14),
  wall(0, 0, 0, 14),
  wall(24, 0, 24, 14),
  // A | B, door z 6..8
  wall(8, 0, 8, 6),
  wall(8, 8, 8, 14),
  // B | C+D, door z 3..5
  wall(16, 0, 16, 3),
  wall(16, 5, 16, 14),
  // C / D, door x 19..21
  wall(16, 7, 19, 7),
  wall(21, 7, 24, 7),
];

export interface Room {
  name: string;
  min: [number, number];
  max: [number, number];
  color: number;
}

export const rooms: Room[] = [
  { name: 'A', min: [0, 0], max: [8, 14], color: 0x2a3340 },
  { name: 'B', min: [8, 0], max: [16, 14], color: 0x2d3a36 },
  { name: 'C', min: [16, 0], max: [24, 7], color: 0x3a3430 },
  { name: 'D', min: [16, 7], max: [24, 14], color: 0x372f3c },
];

/** Printed fiducials at known world positions. An agent that walks over one re-anchors its pose. */
export interface Marker {
  id: string;
  pos: Vec3;
}

export const markers: Marker[] = [
  { id: 'M-A', pos: [6, 0, 4] },
  { id: 'M-B', pos: [14, 0, 3] },
  { id: 'M-C', pos: [22, 0, 2] },
  { id: 'M-D', pos: [22, 0, 12] },
];

export const ANCHOR_RADIUS = 1.5;
