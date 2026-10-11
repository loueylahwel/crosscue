import { describe, expect, it } from 'vitest';
import { dist } from '../src/core/math';
import type { Observation } from '../src/core/types';
import { WorldModel } from '../src/core/worldModel';

let seq = 0;
const obs = (o: Partial<Observation> & Pick<Observation, 'pos'>): Observation => ({
  origin: 'A',
  seq: ++seq,
  t: 0,
  label: 'person',
  sigma: 0.2,
  ...o,
});

describe('WorldModel fusion', () => {
  it('creates a track on first sighting', () => {
    const wm = new WorldModel();
    wm.ingest(obs({ pos: [1, 0, 2], id: 'p1' }), 0);
    const [t] = wm.current(0);
    expect(t.pos).toEqual([1, 0, 2]);
    expect(t.freshness).toBe(1);
  });

  it('weights a precise observer more than a sloppy one', () => {
    const wm = new WorldModel();
    wm.ingest(obs({ origin: 'A', pos: [0, 0, 0], sigma: 0.05, id: 'x' }), 0);
    wm.ingest(obs({ origin: 'B', pos: [1, 0, 0], sigma: 0.5, id: 'x' }), 0);
    const [t] = wm.current(0);
    // inverse-variance weight: 0.05^2 vs 0.5^2 -> ~1% pull towards the sloppy one
    expect(t.pos[0]).toBeGreaterThan(0);
    expect(t.pos[0]).toBeLessThan(0.05);
  });

  it('two equally good observers meet in the middle and are more certain', () => {
    const wm = new WorldModel();
    wm.ingest(obs({ origin: 'A', pos: [0, 0, 0], sigma: 0.2, id: 'x' }), 0);
    wm.ingest(obs({ origin: 'B', pos: [1, 0, 0], sigma: 0.2, id: 'x' }), 0);
    const [t] = wm.current(0);
    expect(t.pos[0]).toBeCloseTo(0.5, 6);
    expect(t.sigma).toBeLessThan(0.2);
  });

  it('ignores an older message from the same origin that arrives late', () => {
    const wm = new WorldModel();
    const first = obs({ pos: [0, 0, 0], id: 'x' });
    const second = obs({ pos: [5, 0, 0], id: 'x' });
    wm.ingest(second, 0);
    expect(wm.ingest(first, 10)).toBeNull();
    expect(wm.current(10)[0].pos[0]).toBeCloseTo(5, 6);
  });

  it('estimates velocity and extrapolates a moving target', () => {
    const wm = new WorldModel();
    for (let i = 0; i <= 30; i++) wm.ingest(obs({ pos: [i * 0.1, 0, 0], id: 'x', sigma: 0.05 }), i * 100); // 1 m/s
    const [t] = wm.current(3000);
    expect(t.vel[0]).toBeGreaterThan(0.7);
    const later = wm.current(3300)[0];
    expect(later.pos[0]).toBeGreaterThan(t.pos[0]);
  });

  it('marks tracks stale, then drops them', () => {
    const wm = new WorldModel({ staleMs: 1000, dropMs: 3000, gateM: 1, processSpeed: 1, maxExtrapolateMs: 500 });
    wm.ingest(obs({ pos: [0, 0, 0], id: 'x' }), 0);
    expect(wm.current(500)[0].stale).toBe(false);
    const stale = wm.current(1500)[0];
    expect(stale.stale).toBe(true);
    expect(stale.freshness).toBe(0);
    expect(stale.sigma).toBeGreaterThan(1);
    expect(wm.current(3500)).toHaveLength(0);
  });

  it('associates id-less observations by label and distance gate', () => {
    const wm = new WorldModel();
    wm.ingest(obs({ pos: [0, 0, 0] }), 0);
    wm.ingest(obs({ pos: [0.3, 0, 0], origin: 'B' }), 100); // same person, seen by B
    wm.ingest(obs({ pos: [20, 0, 0], origin: 'B' }), 100); // a different person
    expect(wm.current(100)).toHaveLength(2);
    wm.ingest(obs({ pos: [0, 0, 0], label: 'dog' }), 100); // other label never merges
    expect(wm.current(100)).toHaveLength(3);
  });

  it('keeps separate stable ids apart even when close', () => {
    const wm = new WorldModel();
    wm.ingest(obs({ pos: [0, 0, 0], id: 'a' }), 0);
    wm.ingest(obs({ pos: [0.1, 0, 0], id: 'b' }), 0);
    const views = wm.current(0);
    expect(views).toHaveLength(2);
    expect(dist(views[0].pos, views[1].pos)).toBeCloseTo(0.1, 6);
  });
});
