import type { NodeId, Packet } from './types';

/**
 * The only thing the mesh logic knows about the network. Implementations:
 *   SimNetwork transport (range-limited, lossy)  - Stage 1
 *   WebSocket relay transport                    - Stage 2
 *   Nearby Connections / BLE (native Android)    - Stage 3
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
