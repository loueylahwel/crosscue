import { add, clamp, dist, length, lerp, scale, sub } from './math';
import type { NodeId, Observation, Vec3 } from './types';

export interface WorldModelOptions {
  /** After this long without an update a track is shown as stale (faded). */
  staleMs: number;
  /** After this long without an update a track is removed. */
  dropMs: number;
  /** Extra association distance (m) for observations that carry no stable id. */
  gateM: number;
  /** Unmodelled target speed (m/s): how fast uncertainty grows between updates. */
  processSpeed: number;
  /** Never extrapolate a track further ahead than this. */
  maxExtrapolateMs: number;
}

export const defaultWorldModelOptions: WorldModelOptions = {
  staleMs: 2500,
  dropMs: 10000,
  gateM: 1.0,
  processSpeed: 1.0,
  maxExtrapolateMs: 1500,
};

interface Track {
  key: string;
  label: string;
  id?: string;
  pos: Vec3;
  vel: Vec3;
  variance: number; // m^2, isotropic position variance
  lastRecv: number; // LOCAL clock ms of the last update
  lastSeq: Map<NodeId, number>;
  lastOrigin: NodeId;
  lastHops: number;
}

/** What the renderer draws. */
export interface TrackView {
  key: string;
  label: string;
  id?: string;
  pos: Vec3; // extrapolated to `now`
  vel: Vec3;
  sigma: number; // m, grows while no new data arrives
  ageMs: number;
  freshness: number; // 1 = just updated, 0 = stale
  stale: boolean;
  lastOrigin: NodeId;
  lastHops: number;
}

const VEL_GAIN = 0.4; // alpha-beta velocity gain
const MAX_SPEED = 10; // m/s, sanity clamp on the velocity estimate

/**
 * Fused picture of every target, from every observer's reports (already in the shared frame W).
 *
 * Time: observer clocks are not synchronised across real devices, so ageing uses the LOCAL
 * receive time passed to `ingest`. `Observation.t` is not used for ageing here; out-of-order
 * delivery is handled with the per-origin sequence number instead.
 */
export class WorldModel {
  private tracks = new Map<string, Track>();
  private counter = 0;

  constructor(readonly opts: WorldModelOptions = defaultWorldModelOptions) {}

  /** Fold one observation in. Returns the track key it was merged into, or null if it was stale. */
  ingest(obs: Observation, recvNow: number, hops = 1): string | null {
    const track = this.associate(obs, recvNow);
    if (!track) return this.createTrack(obs, recvNow, hops).key;

    const prevSeq = track.lastSeq.get(obs.origin);
    if (prevSeq !== undefined && obs.seq <= prevSeq) return null; // older than what we have from this origin
    track.lastSeq.set(obs.origin, obs.seq);

    const dt = Math.max(0, recvNow - track.lastRecv) / 1000;
    const ext = Math.min(dt, this.opts.maxExtrapolateMs / 1000);
    const predPos = add(track.pos, scale(track.vel, ext));
    const predVar = track.variance + (this.opts.processSpeed * dt) ** 2;
    const r2 = Math.max(obs.sigma, 1e-3) ** 2;
    const gain = predVar / (predVar + r2);
    const resid = sub(obs.pos, predPos);

    track.pos = add(predPos, scale(resid, gain));
    track.variance = (1 - gain) * predVar;
    if (obs.vel) {
      track.vel = lerp(track.vel, obs.vel, gain);
    } else if (dt > 0.05) {
      track.vel = add(track.vel, scale(resid, (VEL_GAIN * gain) / dt));
    }
    const speed = length(track.vel);
    if (speed > MAX_SPEED) track.vel = scale(track.vel, MAX_SPEED / speed);

    track.lastRecv = recvNow;
    track.lastOrigin = obs.origin;
    track.lastHops = hops;
    return track.key;
  }

  /** Tracks as they should be drawn at `now`. Also removes tracks past `dropMs`. */
  current(now: number): TrackView[] {
    const views: TrackView[] = [];
    for (const [key, t] of this.tracks) {
      const age = Math.max(0, now - t.lastRecv);
      if (age > this.opts.dropMs) {
        this.tracks.delete(key);
        continue;
      }
      const ext = Math.min(age, this.opts.maxExtrapolateMs) / 1000;
      views.push({
        key,
        label: t.label,
        id: t.id,
        pos: add(t.pos, scale(t.vel, ext)),
        vel: t.vel,
        sigma: Math.sqrt(t.variance + (this.opts.processSpeed * (age / 1000)) ** 2),
        ageMs: age,
        freshness: clamp(1 - age / this.opts.staleMs, 0, 1),
        stale: age > this.opts.staleMs,
        lastOrigin: t.lastOrigin,
        lastHops: t.lastHops,
      });
    }
    return views;
  }

  clear(): void {
    this.tracks.clear();
  }

  private associate(obs: Observation, now: number): Track | null {
    if (obs.id !== undefined) return this.tracks.get(`id:${obs.id}`) ?? null;
    let best: Track | null = null;
    let bestD = Infinity;
    for (const t of this.tracks.values()) {
      if (t.id !== undefined || t.label !== obs.label) continue;
      const ext = Math.min(Math.max(0, now - t.lastRecv), this.opts.maxExtrapolateMs) / 1000;
      const d = dist(add(t.pos, scale(t.vel, ext)), obs.pos);
      const gate = this.opts.gateM + 3 * Math.sqrt(t.variance) + 3 * obs.sigma;
      if (d <= gate && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  private createTrack(obs: Observation, recvNow: number, hops: number): Track {
    const key = obs.id !== undefined ? `id:${obs.id}` : `${obs.label}~${this.counter++}`;
    const t: Track = {
      key,
      label: obs.label,
      id: obs.id,
      pos: obs.pos,
      vel: obs.vel ?? [0, 0, 0],
      variance: Math.max(obs.sigma, 1e-3) ** 2,
      lastRecv: recvNow,
      lastSeq: new Map([[obs.origin, obs.seq]]),
      lastOrigin: obs.origin,
      lastHops: hops,
    };
    this.tracks.set(key, t);
    return t;
  }
}
