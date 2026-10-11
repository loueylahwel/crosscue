import { describe, expect, it } from 'vitest';
import { dist } from '../src/core/math';
import { pushOutOfWalls } from '../src/core/geometry';
import { toLocal, toWorld } from '../src/core/transform';
import { Sim } from '../src/sim/sim';
import { walls } from '../src/sim/world';

const ghostPos = (sim: Sim, viewer: number, targetId: string) => {
  const a = sim.agents[viewer];
  const tr = a.model.current(sim.net.now).find((t) => t.id === targetId);
  return tr ? toWorld(a.truePose(), toLocal(a.estPose(), tr.pos)) : null; // where the viewer would DRAW it
};

describe('pushOutOfWalls', () => {
  it('moves a point out of a wall and leaves free points alone', () => {
    const inWall = pushOutOfWalls([8, 0, 3], 0.3, walls); // x=8 is the A|B wall, z=3 is solid
    expect(Math.abs(inWall[0] - 8)).toBeGreaterThan(0.3);
    expect(pushOutOfWalls([4, 0, 4], 0.3, walls)).toEqual([4, 0, 4]);
  });

  it('lets an agent through a doorway', () => {
    expect(pushOutOfWalls([8, 0, 7], 0.3, walls)).toEqual([8, 0, 7]);
  });
});

describe('Sim: chain scenario (the relay demo)', () => {
  it('Charlie sees Alpha\'s target through two walls, via Bravo, while Alpha and Charlie are out of radio range', () => {
    const sim = new Sim();
    sim.applyScenario('chain');
    sim.params.sensorNoiseM = 0.02;
    sim.run(3);

    expect(sim.net.linked('A', 'C')).toBe(false);
    expect(sim.net.linked('A', 'B')).toBe(true);
    expect(sim.net.linked('B', 'C')).toBe(true);

    expect(sim.agents[0].seeing.has('T1')).toBe(true); // Alpha sees it with its own eyes
    expect(sim.agents[2].seeing.has('T1')).toBe(false); // Charlie cannot (walls, range)

    const track = sim.agents[2].model.current(sim.net.now).find((t) => t.id === 'T1');
    expect(track).toBeDefined();
    expect(track!.lastHops).toBe(2);
    expect(track!.lastOrigin).toBe('A');
    expect(dist(ghostPos(sim, 2, 'T1')!, [5, 1, 7])).toBeLessThan(0.3);
  });

  it('killing Bravo cuts Charlie off; ghost goes stale and disappears', () => {
    const sim = new Sim();
    sim.applyScenario('chain');
    sim.run(2);
    expect(sim.agents[2].model.current(sim.net.now)).toHaveLength(1);
    sim.setAlive(1, false);
    sim.run(4);
    expect(sim.agents[2].model.current(sim.net.now)[0].stale).toBe(true);
    sim.run(8);
    expect(sim.agents[2].model.current(sim.net.now)).toHaveLength(0);
  });

  it('with relaying off Charlie never learns about the target', () => {
    const sim = new Sim();
    sim.applyScenario('chain');
    sim.params.relay = false;
    sim.run(3);
    expect(sim.agents[2].model.current(sim.net.now)).toHaveLength(0);
    expect(sim.agents[1].model.current(sim.net.now)).toHaveLength(1); // Bravo, one hop away, still hears Alpha
  });

  it('with the radios off nobody learns about anyone else\'s sightings', () => {
    const sim = new Sim();
    sim.applyScenario('chain');
    sim.params.share = false;
    sim.run(3);
    expect(sim.agents[1].model.current(sim.net.now)).toHaveLength(0);
    expect(sim.agents[0].model.current(sim.net.now)).toHaveLength(1); // Alpha still has its own
  });
});

describe('Sim: pose error ends up in the shared picture', () => {
  it('a wrong heading on the observer displaces the ghost everywhere, and a marker fixes it', () => {
    const sim = new Sim();
    sim.applyScenario('chain');
    sim.params.sensorNoiseM = 0.001;
    sim.params.driftPct = 0;
    sim.params.reanchor = false;

    // Alpha believes its heading is 4 degrees off. Target is ~3 m ahead -> ~0.2 m displacement.
    sim.agents[0].yawErr = (4 * Math.PI) / 180;
    sim.run(2);
    const wrong = dist(ghostPos(sim, 2, 'T1')!, [5, 1, 7]);
    expect(wrong).toBeGreaterThan(0.1);

    sim.agents[0].yawErr = 0; // what re-anchoring does
    sim.agents[0].model.clear();
    sim.agents[1].model.clear();
    sim.agents[2].model.clear();
    sim.run(2);
    expect(dist(ghostPos(sim, 2, 'T1')!, [5, 1, 7])).toBeLessThan(0.05);
  });

  it('walking over a marker snaps the error back', () => {
    const sim = new Sim();
    sim.params.freezeNpcs = true;
    sim.params.driftPct = 0;
    const a = sim.agents[0];
    a.yawErr = 0.2;
    a.posErr = [0.5, 0, 0.5];
    a.pos = [6, 0, 4]; // standing on marker M-A
    sim.run(0.2);
    expect(Math.abs(a.yawErr)).toBeLessThan(0.05);
    expect(Math.hypot(a.posErr[0], a.posErr[2])).toBeLessThan(0.15);
  });

  it('drift grows with distance walked', () => {
    const sim = new Sim();
    sim.params.reanchor = false;
    sim.params.driftPct = 2;
    sim.reset();
    const a = sim.agents[0];
    a.posErr = [0, 0, 0];
    sim.controlled = 0;
    sim.run(10, { forward: 1, strafe: 0, turn: 0.3 }); // walk in a circle
    expect(Math.hypot(a.posErr[0], a.posErr[2])).toBeGreaterThan(0.1);
  });
});
