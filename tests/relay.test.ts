import { afterEach, describe, expect, it } from 'vitest';
import { startRelay, type Relay } from '../server/relay';
import { MeshNode } from '../src/core/mesh';
import type { NodeId, Observation } from '../src/core/types';
import { WebSocketTransport } from '../src/live/wsTransport';

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let relay: Relay | null = null;
const transports: WebSocketTransport[] = [];

afterEach(async () => {
  transports.splice(0).forEach((t) => t.close());
  await relay?.close();
  relay = null;
});

async function network(ids: NodeId[], links: [NodeId, NodeId][] | null) {
  relay = await startRelay({ port: 0, host: '127.0.0.1', links });
  const nodes = ids.map((id) => {
    const t = new WebSocketTransport({ url: `ws://127.0.0.1:${relay!.port}`, id, reconnectMs: 50 });
    transports.push(t);
    return new MeshNode(t, { ttl: 4, relay: true });
  });
  const got = new Map<NodeId, { obs: Observation; hops: NodeId[] }[]>(ids.map((id) => [id, []]));
  nodes.forEach((n) => n.onObservation((obs, meta) => got.get(n.id)!.push({ obs, hops: meta.hops })));
  // wait until everyone is connected and has heard about its neighbours
  const expected = (id: NodeId) => ids.filter((o) => o !== id && (!links || links.some(([a, b]) => (a === id && b === o) || (b === id && a === o))));
  await until(() => transports.every((t) => t.status === 'open' && t.neighbors().length === expected(t.id).length));
  return { nodes, got };
}

const sighting = { t: 0, label: 'tag', id: 'tag-1', pos: [1, 0, -2] as [number, number, number], sigma: 0.05 };

describe('WebSocket relay', () => {
  it('everyone hears everyone by default, and duplicates are suppressed', async () => {
    const { nodes, got } = await network(['OBS', 'PHONE', 'LAPTOP'], null);
    nodes[0].publish(sighting);
    await until(() => got.get('PHONE')!.length === 1 && got.get('LAPTOP')!.length === 1);
    await new Promise((r) => setTimeout(r, 100)); // let the relayed copies arrive too
    expect(got.get('PHONE')!.length).toBe(1);
    expect(got.get('PHONE')![0].hops).toEqual(['OBS', 'PHONE']);
    expect(nodes[1].stats.duplicates).toBeGreaterThan(0);
  });

  it('with links A-B and B-C, C hears A only through B', async () => {
    const { nodes, got } = await network(['A', 'B', 'C'], [
      ['A', 'B'],
      ['B', 'C'],
    ]);
    expect(transports[0].neighbors()).toEqual(['B']);
    nodes[0].publish(sighting);
    await until(() => got.get('C')!.length === 1);
    expect(got.get('C')![0].hops).toEqual(['A', 'B', 'C']);
    expect(got.get('C')![0].obs.pos).toEqual([1, 0, -2]);
  });

  it('a node that drops out disappears from its neighbours and can come back', async () => {
    await network(['A', 'B'], null);
    transports[1].close();
    await until(() => transports[0].neighbors().length === 0);
    const again = new WebSocketTransport({ url: `ws://127.0.0.1:${relay!.port}`, id: 'B' });
    transports.push(again);
    await until(() => transports[0].neighbors().includes('B'));
  });

  it('a second connection with the same id takes over and the first one stops', async () => {
    await network(['A'], null);
    const twin = new WebSocketTransport({ url: `ws://127.0.0.1:${relay!.port}`, id: 'A' });
    transports.push(twin);
    await until(() => twin.status === 'open' && transports[0].status === 'closed');
    expect(transports[0].notice).toMatch(/took this id/);
    expect(relay!.nodes()).toEqual(['A']);
  });
});
