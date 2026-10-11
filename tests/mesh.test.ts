import { describe, expect, it } from 'vitest';
import { MeshNode } from '../src/core/mesh';
import { SimNetwork } from '../src/core/simNetwork';
import type { NodeId, Observation, Vec3 } from '../src/core/types';

/** Build a network of mesh nodes at given x positions (metres along a line). */
function line(xs: number[], range = 10, relay = true, ttl = 4) {
  const net = new SimNetwork({ latencyMs: 10, jitterMs: 0, loss: 0 });
  const ids: NodeId[] = xs.map((_, i) => String.fromCharCode(65 + i));
  const nodes = ids.map((id, i) => new MeshNode(net.addNode(id, [xs[i], 0, 0], range), { ttl, relay }));
  const got = new Map<NodeId, { obs: Observation; hops: NodeId[] }[]>();
  nodes.forEach((n) => {
    got.set(n.id, []);
    n.onObservation((obs, meta) => got.get(n.id)!.push({ obs, hops: meta.hops }));
  });
  return { net, nodes, got, ids };
}

const sighting = (pos: Vec3) => ({ t: 0, label: 'person', pos, sigma: 0.2 });

describe('SimNetwork radio range', () => {
  it('links only nodes within range', () => {
    const { net } = line([0, 10, 20], 10);
    expect(net.linked('A', 'B')).toBe(true);
    expect(net.linked('B', 'C')).toBe(true);
    expect(net.linked('A', 'C')).toBe(false);
  });

  it('uses the smaller of the two ranges', () => {
    const net = new SimNetwork();
    net.addNode('A', [0, 0, 0], 30);
    net.addNode('B', [15, 0, 0], 10);
    expect(net.linked('A', 'B')).toBe(false);
  });
});

describe('mesh relay A - B - C', () => {
  it('C receives A\'s sighting through B and the path shows the hop', () => {
    const { net, nodes, got } = line([0, 10, 20]);
    nodes[0].publish(sighting([1, 0, 1]));
    net.advance(500);
    expect(got.get('B')).toHaveLength(1);
    expect(got.get('C')).toHaveLength(1);
    expect(got.get('C')![0].hops).toEqual(['A', 'B', 'C']);
  });

  it('without relaying C hears nothing', () => {
    const { net, nodes, got } = line([0, 10, 20], 10, false);
    nodes[0].publish(sighting([1, 0, 1]));
    net.advance(500);
    expect(got.get('B')).toHaveLength(1);
    expect(got.get('C')).toHaveLength(0);
  });

  it('with B dead C hears nothing', () => {
    const { net, nodes, got } = line([0, 10, 20]);
    net.nodes.get('B')!.alive = false;
    nodes[0].publish(sighting([1, 0, 1]));
    net.advance(500);
    expect(got.get('C')).toHaveLength(0);
  });

  it('respects ttl: a long chain stops after ttl forwards', () => {
    const { net, nodes, got } = line([0, 10, 20, 30, 40, 50], 10, true, 2);
    nodes[0].publish(sighting([0, 0, 0]));
    net.advance(2000);
    // A -> B (first send) -> C (fwd 1) -> D (fwd 2); E never hears it
    expect(got.get('D')).toHaveLength(1);
    expect(got.get('E')).toHaveLength(0);
  });

  it('floods in a fully connected cluster without delivering duplicates or looping', () => {
    const { net, nodes, got, ids } = line([0, 1, 2, 3, 4]);
    nodes[2].publish(sighting([0, 0, 0]));
    net.advance(2000);
    for (const id of ids) expect(got.get(id)).toHaveLength(id === 'C' ? 0 : 1);
    // flood terminated: nothing left in flight after the dust settles
    const before = net.stats.sent;
    net.advance(5000);
    expect(net.stats.sent).toBe(before);
  });

  it('does not deliver a node\'s own message back to it', () => {
    const { net, nodes, got } = line([0, 10]);
    nodes[0].publish(sighting([0, 0, 0]));
    net.advance(1000);
    expect(got.get('A')).toHaveLength(0);
  });

  it('numbers messages per origin', () => {
    const { nodes } = line([0, 10]);
    const a = nodes[0].publish(sighting([0, 0, 0]));
    const b = nodes[0].publish(sighting([0, 0, 0]));
    expect(b.seq).toBe(a.seq + 1);
    expect(a.origin).toBe('A');
  });
});

describe('lossy links', () => {
  it('multipath flooding delivers more often than a single link would', () => {
    // A reaches D by two disjoint paths (via B and via C). With 40% loss per hop a single
    // path would deliver 0.6^2 = 36%; two paths should do clearly better.
    let delivered = 0;
    const trials = 300;
    for (let s = 0; s < trials; s++) {
      const net = new SimNetwork({ latencyMs: 5, jitterMs: 0, loss: 0.4, seed: s + 1 });
      const mk = (id: string, pos: Vec3) => new MeshNode(net.addNode(id, pos, 12), { ttl: 3, relay: true });
      const a = mk('A', [0, 0, 0]);
      mk('B', [8, 5, 0]);
      mk('C', [8, -5, 0]);
      const d = mk('D', [16, 0, 0]);
      let heard = false;
      d.onObservation(() => (heard = true));
      a.publish(sighting([0, 0, 0]));
      net.advance(500);
      if (heard) delivered++;
    }
    expect(delivered / trials).toBeGreaterThan(0.45);
  });
});
