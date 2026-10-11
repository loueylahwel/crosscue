# CROSSCUE

Cooperative sighting over a mesh. When one device sees a target, every other device draws it at the right
place in its own view, even through a wall. Devices share **positions in one common world frame**, never
directions relative to themselves, and relay each other's messages hop by hop, so no central server is needed.

The name comes from cross-cueing: one sensor's detection cues every other sensor onto the same target.

Status: **SANDTABLE (the 3D simulation) works.** FTX (PC webcam plus Android phone) and the SPOTREP mobile
app are next. See the roadmap below.

## Names used in this project

| Name | What it is | Where |
|---|---|---|
| CROSSCUE | The whole project | this repo |
| SANDTABLE | Stage 1: the 3D simulation used to rehearse the idea | `src/sim/` |
| FTX | Stage 2: field training exercise with a PC webcam observer, an Android phone viewer and an accuracy rig | planned |
| SPOTREP | Stage 3: the native Android app. Also the name for one sighting message | `Observation` in `src/core/types.ts` |
| DATUM | The shared world frame, defined by a printed marker | `src/core/transform.ts` |
| COP | Common operating picture: every sighting fused into tracks | `src/core/worldModel.ts` |
| RETRANS | The multi-hop mesh relay | `src/core/mesh.ts` |
| CEP50 / CEP95 | Accuracy: radius around the true position that holds 50% / 95% of the estimates | FTX accuracy rig, planned |

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

```bash
npm test
```

```bash
npm run typecheck
```

## SANDTABLE

A 24 m by 14 m house with four rooms. Four agents patrol and you control one of them. Two targets (red)
walk around or stand still. Walls block sight but not radio.

| Key or action | Effect |
|---|---|
| W A S D | Move |
| Q / E, arrow keys, mouse drag | Turn |
| 1 to 4 | Switch which agent you are |
| Tab | Swap the main view between first person and top-down (the other one is the inset) |
| Space | Pause |
| R | Reset |

Ghost colours: green means you see the target yourself, cyan means it arrived over the radio, grey means
the information is stale.

Try the **Relay chain A-B-C** scenario. Alpha sees the target, Bravo stands in the middle, and you are
Charlie: out of Alpha's radio range and behind two walls, yet the target is drawn in your view, two hops
away. Switch Bravo off and the ghost goes stale, then disappears.

The sliders model the real problems: radio range, packet loss, latency, sensor noise, an initial heading
error for every agent, and position drift that grows with distance walked. Each agent only knows its
**estimated** pose and computes the shared position with it, so one wrong heading displaces the ghost for
everybody. Walking over a printed marker (yellow rings) snaps the agent back to the truth. The top-down view
shows each agent's believed position as a ring joined to its real position by a line.

From the browser console, `__sim.run(5)` fast-forwards five simulated seconds.

## DATUM: how devices agree on where things are

A sighting starts out relative to the observer: "3 m ahead, 40 degrees to my left". Nobody else can use that.
So:

1. The observer converts it into the shared world frame W with its own pose: `p_W = pose_obs x p_local`.
2. Only `p_W` is broadcast.
3. A receiver converts it for display with its own pose: `p_local = inverse(pose_rx) x p_W`.

Every phone already knows which way is up, so only four numbers have to be agreed between devices: x, y, z
and one heading angle. In CROSSCUE, W is defined by a printed marker that each device sees once. After that
each device tracks its own motion and re-anchors whenever it sees a marker again.

## Layout

```
src/core/          pure TypeScript, no DOM, unit-tested
  types.ts           Observation (SPOTREP), Packet, Pose4 / Pose6
  transform.ts       DATUM: local <-> world transforms, alignment from two tapped points
  worldModel.ts      COP: inverse-variance fusion, staleness, extrapolation
  mesh.ts            RETRANS: managed flooding with (origin, seq) dedupe, TTL and hop path
  transport.ts       the only interface the mesh knows about the network
  simNetwork.ts      deterministic radio simulator (range, loss, latency) implementing Transport
  geometry.ts        wall line of sight, field of view, collisions
src/sim/           SANDTABLE: world, simulation engine, Three.js scene, HUD
tests/             vitest suites
docs/protocol.md   language-neutral message format, for the native port
```

The simulator, the planned WebSocket relay (FTX) and Nearby Connections (SPOTREP app) all implement the same
`Transport` interface, so the mesh and fusion logic is written and tested once.

## Roadmap

- [x] M0: core library and tests
- [x] M1: SANDTABLE with through-wall ghosts
- [x] M2: radio range, RETRANS relay, loss, noise and drift, live metrics, relay-chain scenario
- [ ] M3: phone checks (WebXR `immersive-ar`, `camera-access`, `adb reverse`) and PC marker detection
- [ ] M4: FTX observer page, relay server and phone viewer with DATUM alignment
- [ ] M5: FTX accuracy rig against measured ground truth, reported as CEP50 / CEP95
- [ ] M6: object detection on the PC webcam
- [ ] M7: SPOTREP native Android app with a Bluetooth / Wi-Fi mesh

## Honest accuracy expectations

These are estimates until the FTX measurements replace them: roughly 10 to 30 cm at house scale.

- A printed marker seen by a fixed webcam at 1 to 3 m is good to a few centimetres.
- One degree of heading error costs about 9 cm at 5 m.
- Phone motion tracking drifts as you walk; studies of smartphone AR report position errors above 10 cm.
- Outdoors, GPS alone is only good to 3 to 5 m.

## Note

CROSSCUE is a personal research prototype for cooperative perception. It is not affiliated with any
defence program or company.
