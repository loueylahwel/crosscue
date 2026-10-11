import { toLocal } from './transform';
import type { Pose4, Vec3 } from './types';

/** Axis-aligned box, used for walls. */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

/** Slab test: does the segment a-b pass through the box? */
export function segmentHitsAABB(a: Vec3, b: Vec3, box: AABB): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) < 1e-9) {
      if (a[i] < box.min[i] || a[i] > box.max[i]) return false;
    } else {
      let ta = (box.min[i] - a[i]) / d;
      let tb = (box.max[i] - a[i]) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}

export function segmentBlocked(a: Vec3, b: Vec3, walls: AABB[]): boolean {
  return walls.some((w) => segmentHitsAABB(a, b, w));
}

/** Push a circle of `radius` (in the XZ plane) out of any wall it overlaps. Returns the corrected position. */
export function pushOutOfWalls(p: Vec3, radius: number, walls: AABB[]): Vec3 {
  let x = p[0];
  let z = p[2];
  for (let pass = 0; pass < 3; pass++) {
    for (const w of walls) {
      const minX = w.min[0] - radius;
      const maxX = w.max[0] + radius;
      const minZ = w.min[2] - radius;
      const maxZ = w.max[2] + radius;
      if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) continue;
      const pushes = [x - minX, maxX - x, z - minZ, maxZ - z]; // penetration depth towards each side
      const m = Math.min(...pushes);
      if (m === pushes[0]) x = minX;
      else if (m === pushes[1]) x = maxX;
      else if (m === pushes[2]) z = minZ;
      else z = maxZ;
    }
  }
  return [x, p[1], z];
}

/** Horizontal bearing of `target` from `pose`: 0 = straight ahead, positive = to the right. */
export function bearingTo(pose: Pose4, target: Vec3): number {
  const l = toLocal(pose, target);
  return Math.atan2(l[0], -l[2]);
}

export interface SightParams {
  fov: number; // horizontal field of view, radians
  range: number; // m
  eyeHeight: number; // m
}

/** Can an agent at `pose` see `target`: in range, inside the horizontal FOV, and no wall in between. */
export function canSee(pose: Pose4, target: Vec3, p: SightParams, walls: AABB[]): boolean {
  const eye: Vec3 = [pose.pos[0], pose.pos[1] + p.eyeHeight, pose.pos[2]];
  const dx = target[0] - eye[0];
  const dz = target[2] - eye[2];
  if (Math.hypot(dx, dz) > p.range) return false;
  if (Math.abs(bearingTo(pose, target)) > p.fov / 2) return false;
  return !segmentBlocked(eye, target, walls);
}
