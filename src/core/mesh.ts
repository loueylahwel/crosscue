import type { Transport } from './transport';
import type { NodeId, Observation, Packet } from './types';

export interface MeshOptions {
  /** Forwards allowed after the first transmission (so a packet travels at most ttl + 1 hops). */
  ttl: number;
  /** If false this node only talks to its direct neighbours and never forwards for others. */
  relay: boolean;
  /** How many message ids to remember for duplicate suppression. */
  seenCapacity?: number;
}

export interface DeliveryMeta {
  /** Path from the origin to this node, both included. hops.length - 1 = hop count. */
  hops: NodeId[];
  /** Direct neighbour it arrived from. */
  from: NodeId;
}

export interface MeshStats {
  published: number;
  received: number;
  delivered: number;
  duplicates: number;
  relayed: number;
  ttlExpired: number;
}

/**
 * Managed flooding: every node rebroadcasts each message it has not seen before, up to `ttl`
 * times, and remembers (origin, seq) so floods die out instead of looping. That lets A reach C
 * through B with no central server and no routing tables. It is simple and robust at the cost
 * of some repeated transmissions, which is fine for ~50-byte position updates.
 */
export class MeshNode {
  readonly stats: MeshStats = { published: 0, received: 0, delivered: 0, duplicates: 0, relayed: 0, ttlExpired: 0 };
  private seq = 0;
  private readonly seen = new Map<string, true>(); // insertion-ordered; oldest evicted first
  private readonly handlers = new Set<(obs: Observation, meta: DeliveryMeta) => void>();

  constructor(
    readonly transport: Transport,
    readonly opts: MeshOptions,
  ) {
    transport.onReceive((pkt, from) => this.handle(pkt, from));
  }

  get id(): NodeId {
    return this.transport.id;
  }

  /** Register a listener for observations from other nodes (not for our own publishes). */
  onObservation(cb: (obs: Observation, meta: DeliveryMeta) => void): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }

  /** Stamp, remember and broadcast a new observation made by this node. */
  publish(partial: Omit<Observation, 'origin' | 'seq'>): Observation {
    const obs: Observation = { ...partial, origin: this.id, seq: ++this.seq };
    this.remember(this.keyOf(obs));
    this.stats.published++;
    this.transport.broadcast({ ttl: this.opts.ttl, hops: [this.id], obs });
    return obs;
  }

  private handle(pkt: Packet, from: NodeId): void {
    this.stats.received++;
    const key = this.keyOf(pkt.obs);
    if (this.seen.has(key)) {
      this.stats.duplicates++;
      return;
    }
    this.remember(key);

    const hops = [...pkt.hops, this.id];
    this.stats.delivered++;
    for (const h of this.handlers) h(pkt.obs, { hops, from });

    if (!this.opts.relay) return;
    if (pkt.ttl <= 0) {
      this.stats.ttlExpired++;
      return;
    }
    this.stats.relayed++;
    this.transport.broadcast({ ttl: pkt.ttl - 1, hops, obs: pkt.obs }, from);
  }

  private keyOf(obs: Observation): string {
    return `${obs.origin}:${obs.seq}`;
  }

  private remember(key: string): void {
    this.seen.set(key, true);
    const cap = this.opts.seenCapacity ?? 4096;
    if (this.seen.size > cap) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
