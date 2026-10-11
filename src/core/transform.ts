import { add, quatConj, quatFromYaw, quatRotate, sub, wrapAngle } from './math';
import type { Pose4, Pose6, Vec3 } from './types';

/**
 * The core of the shared frame:
 *   observer:  p_W = pose_obs x p_local        (toWorld)
 *   receiver:  p_local = inverse(pose_rx) x p_W (toLocal)
 * A device only ever shares p_W, so "north-west of me" never has to be interpreted by anyone else.
 */

const rotY = (yaw: number, v: Vec3): Vec3 => quatRotate(quatFromYaw(yaw), v);

/** Local (device) frame -> world frame. */
export function toWorld(pose: Pose4, local: Vec3): Vec3 {
  return add(rotY(pose.yaw, local), pose.pos);
}

/** World frame -> local (device) frame. */
export function toLocal(pose: Pose4, world: Vec3): Vec3 {
  return rotY(-pose.yaw, sub(world, pose.pos));
}

/** Pose that undoes `a`. */
export function invertPose4(a: Pose4): Pose4 {
  return { pos: rotY(-a.yaw, [-a.pos[0], -a.pos[1], -a.pos[2]]), yaw: -a.yaw };
}

/** a o b: apply b first, then a. */
export function composePose4(a: Pose4, b: Pose4): Pose4 {
  return { pos: add(rotY(a.yaw, b.pos), a.pos), yaw: wrapAngle(a.yaw + b.yaw) };
}

/**
 * Alignment from two tapped points, both in the device's own gravity-aligned frame:
 * `origin` is where W's origin is (e.g. the centre of the printed marker) and `xAxis` is any
 * point along W's +X axis (e.g. the marker's right-hand edge). Returns the local -> W transform.
 * Height is taken from `origin` too, so W's floor is the marker plane.
 */
export function alignFromTwoPoints(origin: Vec3, xAxis: Vec3): Pose4 {
  const dx = xAxis[0] - origin[0];
  const dz = xAxis[2] - origin[2];
  if (Math.hypot(dx, dz) < 1e-6) throw new Error('alignFromTwoPoints: points coincide horizontally');
  const phi = Math.atan2(-dz, dx); // heading of the axis direction in the local frame
  const yaw = -phi;
  const pos = rotY(yaw, origin);
  return { pos: [-pos[0], -pos[1], -pos[2]], yaw: wrapAngle(yaw) };
}

/** Full 6-DoF transform of a point (cameras). */
export function toWorld6(pose: Pose6, local: Vec3): Vec3 {
  return add(quatRotate(pose.quat, local), pose.pos);
}

export function toLocal6(pose: Pose6, world: Vec3): Vec3 {
  return quatRotate(quatConj(pose.quat), sub(world, pose.pos));
}
