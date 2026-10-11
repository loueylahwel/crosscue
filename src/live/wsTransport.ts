import type { Transport } from '../core/transport';
import type { NodeId, Packet } from '../core/types';

export type LinkStatus = 'connecting' | 'open' | 'closed';

export interface WsTransportOptions {
  /** e.g. ws://localhost:8787 */
  url: string;
  id: NodeId;
  /** First reconnect delay; doubles up to 5 s. */
  reconnectMs?: number;
}

/**
 * Transport over the FTX WebSocket relay (server/relay.ts). Uses the platform WebSocket, so it runs in
 * browsers and in Node 22+. Reconnects on its own; transmissions while disconnected are dropped (and
 * counted), the same as a radio that is out of range.
 */
export class WebSocketTransport implements Transport {
  readonly id: NodeId;
  status: LinkStatus = 'connecting';
  /** Last error or notice from the relay. */
  notice = '';
  readonly stats = { sent: 0, received: 0, dropped: 0 };
  onStatus?: (status: LinkStatus) => void;
  onNeighbors?: (neighbors: NodeId[]) => void;

  private ws: WebSocket | null = null;
  private nbrs: NodeId[] = [];
  private receiver: ((pkt: Packet, from: NodeId) => void) | null = null;
  private retryMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly opts: WsTransportOptions) {
    this.id = opts.id;
    this.retryMs = opts.reconnectMs ?? 1000;
    this.connect();
  }

  broadcast(pkt: Packet, except?: NodeId): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.status !== 'open') {
      this.stats.dropped++;
      return;
    }
    this.ws.send(JSON.stringify({ t: 'pkt', pkt, except }));
    this.stats.sent++;
  }

  onReceive(cb: (pkt: Packet, from: NodeId) => void): void {
    this.receiver = cb;
  }

  neighbors(): NodeId[] {
    return this.nbrs;
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.setStatus('closed');
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.notice = String(e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', id: this.id }));
    ws.onmessage = (ev) => {
      let msg: { t: string; neighbors?: NodeId[]; pkt?: Packet; from?: NodeId; message?: string; code?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.retryMs = this.opts.reconnectMs ?? 1000;
        this.notice = '';
        this.setStatus('open');
      }
      if ((msg.t === 'welcome' || msg.t === 'neighbors') && msg.neighbors) {
        this.nbrs = msg.neighbors;
        this.onNeighbors?.(this.nbrs);
      }
      if (msg.t === 'pkt' && msg.pkt && msg.from) {
        this.stats.received++;
        this.receiver?.(msg.pkt, msg.from);
      }
      if (msg.t === 'error') {
        this.notice = msg.message ?? 'error';
        if (msg.code === 'replaced') this.close(); // another tab or device uses our id: do not fight over it
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.nbrs = [];
      this.onNeighbors?.(this.nbrs);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      this.notice = `cannot reach ${this.opts.url}`;
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 5000);
  }

  private setStatus(s: LinkStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus?.(s);
  }
}
