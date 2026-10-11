import { dist, mulberry32 } from './math';
import type { Transport } from './transport';
import type { NodeId, Packet, Vec3 } from './types';

export interface SimNetOptions {
  latencyMs: number; // base one-hop latency
  jitterMs: number; // extra uniform [0, jitter]
  loss: number; // probability a single transmission is dropped, 0..1
  seed: number;
}

export const defaultSimNetOptions: SimNetOptions = { latencyMs: 40, jitterMs: 20, loss: 0, seed: 1 };

export interface SimNodeState {
  id: NodeId;
  pos: Vec3; // TRUE position, drives who is in radio range of whom
  range: number; // m
  alive: boolean;
}

interface InFlight {
  at: number;
  n: number; // tiebreak: send order
  to: NodeId;
  from: NodeId;
  pkt: Packet;
}

/**
 * Deterministic in-memory radio network. Two nodes are linked when both are alive and the distance
 * between them is within the smaller of the two radio ranges. Transmissions can be lost, are delayed
 * by latency + jitter, and are copied through JSON so no object is shared between nodes (like a wire).
 * Time only moves when `advance` is called.
 */
export class SimNetwork {
  readonly nodes = new Map<NodeId, SimNodeState>();
  opts: SimNetOptions;
  now = 0;
  /** Called for every successful delivery (for visualisation). */
  onDeliver?: (from: NodeId, to: NodeId, pkt: Packet) => void;
  readonly stats = { sent: 0, delivered: 0, lost: 0 };

  private rng: () => number;
  private queue: InFlight[] = [];
  private counter = 0;
  private readonly receivers = new Map<NodeId, (pkt: Packet, from: NodeId) => void>();

  constructor(opts: Partial<SimNetOptions> = {}) {
    this.opts = { ...defaultSimNetOptions, ...opts };
    this.rng = mulberry32(this.opts.seed);
  }

  addNode(id: NodeId, pos: Vec3, range: number): Transport {
    this.nodes.set(id, { id, pos, range, alive: true });
    return {
      id,
      broadcast: (pkt, except) => this.broadcast(id, pkt, except),
      onReceive: (cb) => this.receivers.set(id, cb),
      neighbors: () => this.neighborsOf(id),
    };
  }

  linked(a: NodeId, b: NodeId): boolean {
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (!na || !nb || a === b || !na.alive || !nb.alive) return false;
    return dist(na.pos, nb.pos) <= Math.min(na.range, nb.range);
  }

  neighborsOf(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    for (const other of this.nodes.keys()) if (this.linked(id, other)) out.push(other);
    return out;
  }

  /** Every linked pair once, for drawing. */
  links(): [NodeId, NodeId][] {
    const ids = [...this.nodes.keys()];
    const out: [NodeId, NodeId][] = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) if (this.linked(ids[i], ids[j])) out.push([ids[i], ids[j]]);
    return out;
  }

  /** Advance simulated time, delivering everything that comes due (including follow-up relays). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = this.queue[0];
      if (!next || next.at > target) break;
      this.queue.shift();
      this.now = next.at;
      const node = this.nodes.get(next.to);
      const cb = this.receivers.get(next.to);
      if (!node?.alive || !cb) {
        this.stats.lost++;
        continue;
      }
      this.stats.delivered++;
      this.onDeliver?.(next.from, next.to, next.pkt);
      cb(next.pkt, next.from);
    }
    this.now = target;
  }

  private broadcast(from: NodeId, pkt: Packet, except?: NodeId): void {
    for (const to of this.neighborsOf(from)) {
      if (to === except) continue;
      this.stats.sent++;
      if (this.rng() < this.opts.loss) {
        this.stats.lost++;
        continue;
      }
      const delay = this.opts.latencyMs + this.rng() * this.opts.jitterMs;
      this.enqueue({ at: this.now + delay, n: this.counter++, to, from, pkt: JSON.parse(JSON.stringify(pkt)) });
    }
  }

  private enqueue(item: InFlight): void {
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.queue[mid];
      if (m.at < item.at || (m.at === item.at && m.n < item.n)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, item);
  }
}
