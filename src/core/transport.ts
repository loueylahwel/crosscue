import type { NodeId, Packet } from './types';

/**
 * The only thing the mesh logic knows about the network. Implementations:
 *   SimNetwork (range-limited, lossy radio simulator)  src/core/simNetwork.ts
 *   WebSocketTransport (over the FTX relay)            src/live/wsTransport.ts
 */
export interface Transport {
  readonly id: NodeId;
  /** Send to every directly reachable neighbour, optionally skipping one (the node we got it from). */
  broadcast(pkt: Packet, except?: NodeId): void;
  /** Register the single receive callback. `from` is the direct neighbour that sent it. */
  onReceive(cb: (pkt: Packet, from: NodeId) => void): void;
  /** Currently reachable direct neighbours. */
  neighbors(): NodeId[];
}
