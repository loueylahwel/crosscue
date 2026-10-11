/**
 * Conventions (same as Three.js): right-handed, +Y up, metres, a camera/agent with
 * yaw 0 looks down -Z, and positive yaw turns counter-clockwise seen from above.
 */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w (unit)

export type NodeId = string;

/**
 * Gravity-aligned pose: position + heading about +Y. Used for ground agents and for the
 * 4-unknown transform (x, y, z, yaw) that maps a device's local frame into the shared
 * world frame W. Every phone's IMU already agrees on "up", so nothing else must be aligned.
 */
export interface Pose4 {
  pos: Vec3;
  yaw: number; // radians
}

/** Full 6-DoF pose (cameras, which also pitch and roll). */
export interface Pose6 {
  pos: Vec3;
  quat: Quat;
}

/**
 * One sighting, ALREADY converted to the shared world frame W by the observer.
 * Never a direction relative to the observer: the receiver cannot interpret those.
 */
export interface Observation {
  origin: NodeId; // observer that made it
  seq: number; // per-origin counter; (origin, seq) is a unique message id
  t: number; // observer clock, ms (only comparable between nodes in the sim)
  label: string; // class, e.g. "person", "tag"
  id?: string; // stable identity if the observer has one (marker id, tracker id)
  pos: Vec3; // W, metres
  sigma: number; // 1-sigma position uncertainty, metres
  vel?: Vec3; // W, m/s, if the observer can estimate it
}

/** What actually travels between neighbours. ttl = how many more forwards are allowed. */
export interface Packet {
  ttl: number;
  hops: NodeId[]; // path taken so far, origin first
  obs: Observation;
}
