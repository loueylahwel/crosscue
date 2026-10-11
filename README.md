# Shared Vision

Prototype of a "shared vision" system: when one device sees a target, every other device draws it at the
right place in its own view, even through a wall. Devices share **positions in a common world frame**, not
directions relative to themselves, and relay each other's messages (multi-hop) so no central server is needed.

Status: **Stage 1 (3D simulation) works.** Stage 2 (PC webcam + Android phone) and Stage 3 (native app with
Bluetooth mesh) are planned; see "Roadmap".

## Run

```bash
npm install
npm run dev        # simulation at http://localhost:5173
npm test           # unit tests (core library + simulation)
npm run typecheck
```

## The simulation

A 24 m x 14 m house with four rooms. Four agents patrol; you control one (switch with keys 1-4).
Two targets (red) walk around or stand still. Walls block sight but not radio.

| Key / action | Effect |
|---|---|
| W A S D | move the viewer |
| Q / E, arrows, mouse drag | turn |
| 1-4 | switch which agent you are |
| Tab | swap main view between first person and top-down (the other is the inset) |
| Space / R | pause / reset |

Try the **Relay chain A-B-C** scenario: Alpha sees the target, Bravo is in the middle, you are Charlie out of
Alpha's radio range and still see the target through two walls. Switch Bravo off and the ghost goes stale.

Ghost colours: green = you see it yourself, cyan = it arrived over the radio, grey = stale.

The sliders model the real problems: radio range, packet loss, latency, sensor noise, an initial heading error
for each agent, and position drift proportional to distance walked. Each agent knows only its **estimated** pose;
the shared position is computed with it, so a wrong heading displaces the ghost for everybody. Walking over a
printed marker (yellow rings) snaps the agent back to the truth. The top-down view draws each agent's believed
position as a ring joined to its real position by a line.

## How devices agree on where things are

A sighting starts out relative to the observer ("3 m ahead, 40 degrees left"). Nobody else can use that. So:

1. the observer converts it into the shared world frame W with its own pose: `p_W = pose_obs x p_local`;
2. only `p_W` is broadcast;
3. a receiver converts it for display with its own pose: `p_local = inverse(pose_rx) x p_W`.

Every phone knows which way is up, so only four numbers have to be agreed between devices: x, y, z and one
heading angle. In this project W is defined by a printed marker that each device looks at once; after that
each device tracks its own motion and re-anchors whenever it sees a marker again. See `src/core/transform.ts`.

## Layout

```
src/core/        pure TypeScript, no DOM, unit-tested
  types.ts         Observation, Packet, Pose4/Pose6
  transform.ts     local <-> world transforms, alignment from two tapped points
  worldModel.ts    fusion of sightings into tracks (inverse-variance), staleness, extrapolation
  mesh.ts          managed flooding: dedupe on (origin, seq), TTL, hop path
  transport.ts     the only interface the mesh knows about the network
  simNetwork.ts    deterministic radio simulator (range, loss, latency) implementing Transport
  geometry.ts      wall line-of-sight, field of view, collisions
src/sim/         Three.js simulation (world, sim engine, scene, HUD)
tests/           vitest
docs/protocol.md language-neutral message format, for the later Kotlin port
```

The simulator, a WebSocket relay (Stage 2) and Nearby Connections (Stage 3) all implement the same `Transport`
interface, so the mesh and fusion logic is written and tested once.

## Roadmap

- [x] M0 core library and tests
- [x] M1 3D simulation with through-wall ghosts
- [x] M2 radio range, mesh relay, loss/noise/drift, metrics, relay-chain demo
- [ ] M3 phone spikes: WebXR `immersive-ar` on the real phone, `camera-access`, `adb reverse`; PC marker detection
- [ ] M4 PC observer + relay server + phone viewer with alignment
- [ ] M5 accuracy rig with measured ground truth
- [ ] M6 object detection on the PC webcam
- [ ] M7 native Android + Nearby Connections mesh

## Honest accuracy expectations

Estimates to be replaced by Stage 2 measurements: about 10-30 cm at house scale. A marker seen by a fixed
webcam at 1-3 m is good to a few cm; 1 degree of heading error costs about 9 cm at 5 m; phone motion tracking
drifts as you walk (more than 10 cm errors are reported for smartphone AR). Outdoors, GPS is only 3-5 m.
