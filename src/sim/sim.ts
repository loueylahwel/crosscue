import { canSee, pushOutOfWalls, type SightParams } from '../core/geometry';
import { dist, gauss, mulberry32, wrapAngle } from '../core/math';
import { MeshNode } from '../core/mesh';
import { SimNetwork } from '../core/simNetwork';
import { toLocal, toWorld } from '../core/transform';
import type { NodeId, Pose4, Vec3 } from '../core/types';
import { WorldModel } from '../core/worldModel';
import { ANCHOR_RADIUS, markers, walls } from './world';

const rad = (deg: number) => (deg * Math.PI) / 180;

export interface SimParams {
  /** Radios on. Off = every agent only knows what it sees itself. */
  share: boolean;
  /** Nodes forward other nodes' messages (multi-hop). */
  relay: boolean;
  rangeM: number;
  lossPct: number;
  latencyMs: number;
  /** Base 1-sigma sensor noise at 1 m; grows with distance. */
  sensorNoiseM: number;
  /** How wrong each agent's idea of its own heading is right after start / reset. */
  yawErrDeg: number;
  /** Position drift as % of distance walked (visual-inertial odometry is typically around 1%). */
  driftPct: number;
  /** Walking over a printed marker snaps the agent's pose estimate back to the truth. */
  reanchor: boolean;
  paused: boolean;
  /** Freeze every agent and target except the one you control. */
  freezeNpcs: boolean;
}

export const defaultParams: SimParams = {
  share: true,
  relay: true,
  rangeM: 10,
  lossPct: 0,
  latencyMs: 40,
  sensorNoiseM: 0.1,
  yawErrDeg: 2,
  driftPct: 1,
  reanchor: true,
  paused: false,
  freezeNpcs: false,
};

export const SIGHT: SightParams = { fov: rad(90), range: 12, eyeHeight: 1.6 };
export const TARGET_CENTER_Y = 1.0;
const AGENT_RADIUS = 0.3;
const WALK_SPEED = 1.8;
const SENSE_PERIOD = 0.1; // s
export const FLASH_MS = 350;

export interface AgentConfig {
  id: NodeId;
  name: string;
  color: number;
  start: [number, number];
  startYaw: number;
  patrol: [number, number][];
}

export const agentConfigs: AgentConfig[] = [
  { id: 'A', name: 'Alpha', color: 0x3b82f6, start: [3, 3], startYaw: Math.PI, patrol: [[3, 3], [6, 4], [6, 10], [2, 10]] },
  { id: 'B', name: 'Bravo', color: 0x22c55e, start: [12, 3], startYaw: 0, patrol: [[12, 3], [14, 3], [14, 11], [10, 11]] },
  { id: 'C', name: 'Charlie', color: 0xf59e0b, start: [18, 2], startYaw: 0, patrol: [[18, 2], [22, 2], [22, 5], [18, 5]] },
  { id: 'D', name: 'Delta', color: 0xa855f7, start: [18, 10], startYaw: 0, patrol: [[18, 10], [22, 10], [22, 12.5], [18, 12.5]] },
];

export interface Target {
  id: string;
  name: string;
  pos: Vec3; // feet
  start: [number, number];
  route: [number, number][];
  idx: number;
  speed: number;
  moving: boolean;
}

const targetConfigs = [
  {
    id: 'T1',
    name: 'Hostile 1',
    start: [12, 7] as [number, number],
    route: [[12, 7], [5, 7], [4, 10], [4, 4], [5, 7], [12, 7]] as [number, number][],
    speed: 0.9,
    moving: true,
  },
  { id: 'T2', name: 'Hostile 2', start: [21, 11.5] as [number, number], route: [], speed: 0, moving: false },
];

export class Agent {
  pos: Vec3;
  yaw: number;
  /** Error of the agent's own pose estimate (what it BELIEVES minus the truth). */
  posErr: Vec3 = [0, 0, 0];
  yawErr = 0;
  /** What the agent expects its yaw error to be (it cannot know the real value). */
  yawSigma0 = 0;
  driftDir = 0;
  distSinceAnchor = 0;
  atMarker: string | null = null;
  lastAnchorAt = -Infinity;
  alive = true;
  patrolIdx = 0;
  latencyEma = 0;
  hopsEma = 0;
  received = 0;
  /** Target ids this agent currently sees with its own eyes. */
  seeing = new Set<string>();
  readonly mesh: MeshNode;
  readonly model = new WorldModel();

  constructor(
    readonly cfg: AgentConfig,
    mesh: MeshNode,
  ) {
    this.mesh = mesh;
    this.pos = [cfg.start[0], 0, cfg.start[1]];
    this.yaw = cfg.startYaw;
  }

  get id(): NodeId {
    return this.cfg.id;
  }

  truePose(): Pose4 {
    return { pos: this.pos, yaw: this.yaw };
  }

  /** The pose the agent THINKS it has. Everything it publishes or draws goes through this. */
  estPose(): Pose4 {
    return {
      pos: [this.pos[0] + this.posErr[0], this.pos[1], this.pos[2] + this.posErr[2]],
      yaw: this.yaw + this.yawErr,
    };
  }

  /** The agent's own expectation of its pose error, used to set honest observation sigmas. */
  poseSigma(frac: number): { pos: number; yaw: number } {
    const d = this.distSinceAnchor;
    return { pos: 0.03 + frac * d, yaw: Math.hypot(this.yawSigma0, frac * 0.5 * Math.sqrt(d)) };
  }
}

export interface Input {
  forward: number; // -1..1
  strafe: number;
  turn: number; // -1..1, positive = turn left
}

export class Sim {
  readonly params: SimParams = { ...defaultParams };
  readonly net: SimNetwork;
  readonly agents: Agent[] = [];
  readonly targets: Target[] = [];
  controlled = 0;
  readonly linkFlash = new Map<string, number>();
  private rng = mulberry32(7);
  private senseAcc = 0;

  constructor() {
    this.net = new SimNetwork({ latencyMs: this.params.latencyMs, jitterMs: 20, loss: 0, seed: 11 });
    for (const cfg of agentConfigs) {
      const transport = this.net.addNode(cfg.id, [cfg.start[0], 0, cfg.start[1]], this.params.rangeM);
      const mesh = new MeshNode(transport, { ttl: 4, relay: this.params.relay });
      const agent = new Agent(cfg, mesh);
      this.agents.push(agent);
      mesh.onObservation((obs, meta) => {
        agent.model.ingest(obs, this.net.now, meta.hops.length - 1);
        agent.received++;
        const lat = this.net.now - obs.t;
        const k = agent.received === 1 ? 1 : 0.2;
        agent.latencyEma += k * (lat - agent.latencyEma);
        agent.hopsEma += k * (meta.hops.length - 1 - agent.hopsEma);
      });
    }
    for (const t of targetConfigs) {
      this.targets.push({ ...t, pos: [t.start[0], 0, t.start[1]], idx: 0 });
    }
    this.net.onDeliver = (from, to) => this.linkFlash.set(from < to ? `${from}|${to}` : `${to}|${from}`, this.net.now);
    this.reset();
  }

  get viewer(): Agent {
    return this.agents[this.controlled];
  }

  /** Back to the start with fresh pose errors. */
  reset(): void {
    this.net.now = 0;
    this.linkFlash.clear();
    this.senseAcc = 0;
    for (const a of this.agents) {
      a.pos = [a.cfg.start[0], 0, a.cfg.start[1]];
      a.yaw = a.cfg.startYaw;
      a.alive = true;
      a.patrolIdx = 0;
      a.model.clear();
      a.latencyEma = a.hopsEma = 0;
      a.received = 0;
      a.seeing.clear();
      a.atMarker = null;
      a.lastAnchorAt = -Infinity;
      a.distSinceAnchor = 0;
      a.driftDir = this.rng() * Math.PI * 2;
      a.posErr = [0, 0, 0];
      a.yawSigma0 = rad(this.params.yawErrDeg);
      a.yawErr = (this.rng() < 0.5 ? -1 : 1) * a.yawSigma0 * (0.6 + 0.4 * this.rng());
    }
    for (const t of this.targets) {
      t.pos = [t.start[0], 0, t.start[1]];
      t.idx = 0;
    }
    this.applyNetParams();
  }

  /** Preset layouts. */
  applyScenario(name: 'patrol' | 'chain'): void {
    this.reset();
    if (name === 'patrol') {
      this.params.freezeNpcs = false;
      return;
    }
    // chain: Alpha - Bravo - Charlie in a line, 9 m apart, radio range 10 m, so Alpha and Charlie
    // are out of direct range and can only talk through Bravo. Charlie watches from room D.
    Object.assign(this.params, { rangeM: 10, freezeNpcs: true, relay: true, share: true, yawErrDeg: 0 });
    const place = (i: number, x: number, z: number, yaw: number) => {
      const a = this.agents[i];
      a.pos = [x, 0, z];
      a.yaw = yaw;
      a.yawSigma0 = rad(0.3);
      a.yawErr = 0;
    };
    place(0, 2, 7, -Math.PI / 2); // Alpha faces east at the target
    place(1, 11, 7, -Math.PI / 2);
    place(2, 20, 11, Math.PI / 2); // Charlie faces west
    this.agents[3].alive = false;
    const t1 = this.targets[0];
    t1.pos = [5, 0, 7];
    t1.moving = false;
    this.controlled = 2;
    this.applyNetParams();
  }

  setAlive(i: number, alive: boolean): void {
    this.agents[i].alive = alive;
    this.applyNetParams();
  }

  /** Push slider values into the network and mesh nodes. */
  applyNetParams(): void {
    const p = this.params;
    this.net.opts.loss = p.lossPct / 100;
    this.net.opts.latencyMs = p.latencyMs;
    for (const a of this.agents) {
      const node = this.net.nodes.get(a.id)!;
      node.range = p.share ? p.rangeM : 0;
      node.alive = a.alive;
      a.mesh.opts.relay = p.relay;
    }
  }

  step(dt: number, input: Input): void {
    if (this.params.paused) return;
    this.applyNetParams();
    const frac = this.params.driftPct / 100;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      const before = a.pos;
      if (i === this.controlled) this.moveControlled(a, dt, input);
      else if (!this.params.freezeNpcs) this.movePatrol(a, dt);
      a.pos = pushOutOfWalls(a.pos, AGENT_RADIUS, walls);
      const ds = dist(before, a.pos);
      a.distSinceAnchor += ds;
      this.drift(a, ds, frac);
      this.net.nodes.get(a.id)!.pos = a.pos;
      if (this.params.reanchor) this.checkAnchor(a);
    }

    if (!this.params.freezeNpcs) for (const t of this.targets) this.moveTarget(t, dt);

    this.senseAcc += dt;
    while (this.senseAcc >= SENSE_PERIOD) {
      this.senseAcc -= SENSE_PERIOD;
      this.sense(frac);
    }
    this.net.advance(dt * 1000);
  }

  /** Run `seconds` of simulation with no input (used by tests and the debug console). */
  run(seconds: number, input: Input = { forward: 0, strafe: 0, turn: 0 }): void {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) this.step(dt, input);
  }

  private moveControlled(a: Agent, dt: number, input: Input): void {
    a.yaw = wrapAngle(a.yaw + input.turn * 2.2 * dt);
    const fwd: Vec3 = [-Math.sin(a.yaw), 0, -Math.cos(a.yaw)];
    const right: Vec3 = [Math.cos(a.yaw), 0, -Math.sin(a.yaw)];
    const len = Math.hypot(input.forward, input.strafe) || 1;
    const s = (WALK_SPEED * dt) / Math.max(1, len);
    a.pos = [
      a.pos[0] + (fwd[0] * input.forward + right[0] * input.strafe) * s,
      0,
      a.pos[2] + (fwd[2] * input.forward + right[2] * input.strafe) * s,
    ];
  }

  private movePatrol(a: Agent, dt: number): void {
    const wp = a.cfg.patrol[a.patrolIdx];
    const dx = wp[0] - a.pos[0];
    const dz = wp[1] - a.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.2) {
      a.patrolIdx = (a.patrolIdx + 1) % a.cfg.patrol.length;
      return;
    }
    const want = Math.atan2(-dx, -dz);
    const diff = wrapAngle(want - a.yaw);
    a.yaw = wrapAngle(a.yaw + Math.sign(diff) * Math.min(Math.abs(diff), 3 * dt));
    if (Math.abs(diff) < 0.6) {
      const step = Math.min(d, 1.2 * dt);
      a.pos = [a.pos[0] + (dx / d) * step, 0, a.pos[2] + (dz / d) * step];
    }
  }

  private moveTarget(t: Target, dt: number): void {
    if (!t.moving || t.route.length === 0) return;
    const wp = t.route[(t.idx + 1) % t.route.length];
    const dx = wp[0] - t.pos[0];
    const dz = wp[1] - t.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.1) {
      t.idx = (t.idx + 1) % t.route.length;
      return;
    }
    const step = Math.min(d, t.speed * dt);
    t.pos = [t.pos[0] + (dx / d) * step, 0, t.pos[2] + (dz / d) * step];
  }

  /** Visual-inertial odometry drifts roughly in proportion to distance walked. */
  private drift(a: Agent, ds: number, frac: number): void {
    if (ds <= 0) return;
    a.driftDir += gauss(this.rng) * 0.3 * Math.sqrt(ds);
    a.posErr[0] += Math.cos(a.driftDir) * ds * frac;
    a.posErr[2] += Math.sin(a.driftDir) * ds * frac;
    a.yawErr += gauss(this.rng) * frac * 0.5 * Math.sqrt(ds);
  }

  private checkAnchor(a: Agent): void {
    let near: string | null = null;
    for (const m of markers) {
      if (Math.hypot(a.pos[0] - m.pos[0], a.pos[2] - m.pos[2]) <= ANCHOR_RADIUS) near = m.id;
    }
    if (near && near !== a.atMarker) {
      a.posErr = [gauss(this.rng) * 0.02, 0, gauss(this.rng) * 0.02];
      a.yawSigma0 = rad(0.3);
      a.yawErr = gauss(this.rng) * a.yawSigma0;
      a.distSinceAnchor = 0;
      a.lastAnchorAt = this.net.now;
    }
    a.atMarker = near;
  }

  /** Each live agent looks for targets, measures them in ITS OWN frame, and shares the world-frame result. */
  private sense(frac: number): void {
    for (const a of this.agents) {
      a.seeing.clear();
      if (!a.alive) continue;
      const truth = a.truePose();
      const est = a.estPose();
      const ps = a.poseSigma(frac);
      for (const t of this.targets) {
        const center: Vec3 = [t.pos[0], TARGET_CENTER_Y, t.pos[2]];
        if (!canSee(truth, center, SIGHT, walls)) continue;
        a.seeing.add(t.id);
        const rel = toLocal(truth, center); // what the camera really sees, relative to the agent
        const d = Math.hypot(rel[0], rel[1], rel[2]);
        const measSigma = this.params.sensorNoiseM * (1 + d / 5);
        const noisy: Vec3 = [
          rel[0] + gauss(this.rng) * measSigma,
          rel[1] + gauss(this.rng) * measSigma,
          rel[2] + gauss(this.rng) * measSigma,
        ];
        // To world with the agent's ESTIMATED pose: any pose error ends up in the shared position.
        const reported = toWorld(est, noisy);
        const sigma = Math.hypot(measSigma, ps.pos, ps.yaw * d);
        const obs = a.mesh.publish({ t: this.net.now, label: 'person', id: t.id, pos: reported, sigma });
        a.model.ingest(obs, this.net.now, 0);
      }
    }
  }
}
