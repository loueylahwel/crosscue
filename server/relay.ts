import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { NodeId, Packet } from '../src/core/types';

/**
 * FTX stand-in for the radio. Every browser (webcam observer, phone viewer, a laptop acting as a relay
 * node) connects here with its node id. The relay is NOT the mesh: it only carries one transmission
 * from a node to that node's direct neighbours, exactly like SimNetwork does in SANDTABLE. Flooding,
 * duplicate suppression and TTL stay in each node's MeshNode.
 *
 * By default every connected node hears every other (one shared channel). A link table such as
 * `A-B,B-C` restricts who hears whom, so A reaches C only if B forwards: a real multi-hop test with
 * real devices in one room.
 *
 * Wire format (JSON text frames):
 *   node  -> relay  { t: 'hello', id }              first message
 *   node  -> relay  { t: 'pkt', pkt, except? }      transmit to neighbours (except one)
 *   relay -> node   { t: 'welcome', id, neighbors }
 *   relay -> node   { t: 'neighbors', neighbors }   whenever the set changes
 *   relay -> node   { t: 'pkt', pkt, from }
 *   relay -> node   { t: 'error', message, code? }   code 'replaced': another connection took this id
 */

export interface RelayOptions {
  port: number; // 0 picks a free port
  host?: string;
  /** Allowed direct links; null or empty means everyone hears everyone. */
  links?: [NodeId, NodeId][] | null;
  /** Append every carried packet as a JSON line to this file. */
  logFile?: string;
  log?: (line: string) => void;
}

export interface Relay {
  port: number;
  nodes(): NodeId[];
  close(): Promise<void>;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;

function isPacket(p: unknown): p is Packet {
  const k = p as Packet;
  return (
    !!k &&
    typeof k.ttl === 'number' &&
    Array.isArray(k.hops) &&
    !!k.obs &&
    typeof k.obs.origin === 'string' &&
    typeof k.obs.seq === 'number' &&
    Array.isArray(k.obs.pos) &&
    k.obs.pos.length === 3 &&
    k.obs.pos.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

export function startRelay(opts: RelayOptions): Promise<Relay> {
  const log = opts.log ?? (() => undefined);
  const links = opts.links?.length ? opts.links : null;
  const sockets = new Map<NodeId, WebSocket>();

  const linked = (a: NodeId, b: NodeId) =>
    a !== b && (!links || links.some(([x, y]) => (x === a && y === b) || (x === b && y === a)));
  const neighborsOf = (id: NodeId) => [...sockets.keys()].filter((o) => linked(id, o));
  const send = (ws: WebSocket, msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const announce = () => {
    for (const [id, ws] of sockets) send(ws, { t: 'neighbors', neighbors: neighborsOf(id) });
  };

  const wss = new WebSocketServer({ port: opts.port, host: opts.host });

  wss.on('connection', (ws, req) => {
    let id: NodeId | null = null;
    const addr = req.socket.remoteAddress;

    ws.on('message', (data) => {
      let msg: { t?: string; id?: unknown; pkt?: unknown; except?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        send(ws, { t: 'error', message: 'not JSON' });
        return;
      }
      if (msg.t === 'hello') {
        if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) {
          send(ws, { t: 'error', message: 'bad id: use 1 to 32 letters, digits, _ . -' });
          ws.close();
          return;
        }
        id = msg.id;
        const old = sockets.get(id);
        if (old && old !== ws) {
          send(old, { t: 'error', code: 'replaced', message: 'another connection took this id' });
          old.close();
        }
        sockets.set(id, ws);
        log(`+ ${id} (${addr}), ${sockets.size} connected`);
        send(ws, { t: 'welcome', id, neighbors: neighborsOf(id) });
        announce();
        return;
      }
      if (msg.t === 'pkt') {
        if (!id) return send(ws, { t: 'error', message: 'say hello first' });
        if (!isPacket(msg.pkt)) return send(ws, { t: 'error', message: 'malformed packet' });
        const except = typeof msg.except === 'string' ? msg.except : undefined;
        const to = neighborsOf(id).filter((n) => n !== except);
        for (const n of to) send(sockets.get(n)!, { t: 'pkt', pkt: msg.pkt, from: id });
        if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify({ at: Date.now(), from: id, to, pkt: msg.pkt }) + '\n');
        return;
      }
      send(ws, { t: 'error', message: `unknown message type ${String(msg.t)}` });
    });

    ws.on('close', () => {
      if (id && sockets.get(id) === ws) {
        sockets.delete(id);
        log(`- ${id}, ${sockets.size} connected`);
        announce();
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const addr = wss.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : opts.port,
        nodes: () => [...sockets.keys()],
        close: () =>
          new Promise<void>((done) => {
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}

/** `npm run relay -- [--port 8787] [--links A-B,B-C] [--log file.jsonl]` */
function parseArgs(argv: string[]): RelayOptions {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const links = get('links')
    ?.split(',')
    .filter(Boolean)
    .map((pair) => pair.split('-') as [NodeId, NodeId]);
  return { port: Number(get('port') ?? 8787), links, logFile: get('log'), log: (l) => console.log(`[relay] ${l}`) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = parseArgs(process.argv.slice(2));
  startRelay(opts).then((r) => {
    console.log(`[relay] listening on ws://0.0.0.0:${r.port}` + (opts.links?.length ? ` with links ${opts.links.map((l) => l.join('-')).join(', ')}` : ' (everyone hears everyone)'));
  });
}
