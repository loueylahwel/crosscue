# CROSSCUE

Cooperative sighting over a mesh. When one device sees a target, every other device draws it at the right
place in its own view, even through a wall. Devices share **positions in one common world frame**, never
directions relative to themselves, and relay each other's messages hop by hop, so no central server is needed.

The name comes from cross-cueing: one sensor's detection cues every other sensor onto the same target.

This repository holds SANDTABLE, a 3D simulation of the idea, and FTX, the tools for running it with real
devices: printable markers, a webcam observer, a WebSocket relay and a phone capability check.

## Names used in this project

| Name | What it is | Where |
|---|---|---|
| CROSSCUE | The whole project | this repo |
| SANDTABLE | The 3D simulation used to rehearse the idea | `src/sim/` |
| FTX | Field training exercise: the tools for real devices (markers, observer, relay, phone check) | `src/live/`, `server/` |
| SPOTREP | One sighting message | `Observation` in `src/core/types.ts` |
| DATUM | The shared world frame, defined by a printed marker | `src/core/transform.ts` |
| COP | Common operating picture: every sighting fused into tracks | `src/core/worldModel.ts` |
| RETRANS | The multi-hop mesh relay | `src/core/mesh.ts` |

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

## FTX: real devices

```bash
npm run dev
```

```bash
npm run relay
```

| Page (on the PC, http://localhost:5173/...) | What it does |
|---|---|
| `src/live/markers.html` | Printable marker sheets: the origin (ID 0) and the target (ID 1), ArUco ARUCO_MIP_36h12 at an exact size in millimetres, with a 100 mm line to check the printer did not scale |
| `src/live/observer.html` | Webcam observer: detects both markers, defines DATUM from the origin, computes the target's position in the shared frame with an expected error, and publishes it over the relay. Records accuracy points against tape-measured positions. Has a built-in test scene with known truth, so it can be tried without a webcam |
| `src/live/xrcheck.html` | Phone check: reports what the phone's browser supports for AR (WebXR session, hit test, DOM overlay, camera access, depth, anchors) and sends the report back to the PC |

Observer, step by step:

1. Print the sheets at 100% and measure each black square with a ruler.
2. Tape the origin sheet flat on the floor where the webcam sees it. Stand the target sheet upright facing the
   webcam (a marker lying flat is foreshortened too much to be read beyond about 4 m).
3. Open the observer, pick the webcam and type the measured sizes.
4. Calibrate the field of view once per webcam: target 2 to 4 m beyond the origin, roughly straight away from
   the camera, centre-to-centre distance measured with a tape. A wrong field of view scales every distance.
5. Press Lock DATUM (30 frames are averaged; outlier frames are dropped). The grid drawn on the floor should
   sit on the real floor.
6. Tick Publish. Every node connected to the relay receives the sightings.

**Accuracy runs.** With DATUM locked, put the target at 5 to 8 spots 1 to 6 m from the camera. For each spot,
measure with a tape where the centre of the target's black square is in W (X towards the origin marker's right-hand
edge and Z towards its printed bottom edge, both from its centre, and its height above the floor), type it into the
observer's Accuracy section and press Record point. The observer keeps every frame of the point (30 by default), shows
the error per point and sends the point to the PC, which appends it to `.local/reports/accuracy.jsonl`. Then:

```bash
npm run accuracy
```

This prints the errors of the latest session per point, by distance and overall, including CEP50 and CEP95: the
radius around the true position, measured on the floor plan, that holds 50% (or 95%) of the estimates.
`npm run accuracy -- --all` covers every session.

A phone on USB reaches the PC's pages and relay through `adb reverse`, which Chrome treats as a secure origin:

```bash
adb reverse tcp:5173 tcp:5173
```

```bash
adb reverse tcp:8787 tcp:8787
```

The relay is the radio, not the mesh: it only carries one transmission to the sender's direct neighbours, and
each node floods, deduplicates and counts TTL itself. `npm run relay -- --links A-B,B-C` restricts who hears
whom, so A reaches C only through B; `--log packets.jsonl` records every transmission.

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
  camera.ts          marker pose from four corners, floor ray, DATUM from the origin marker, error model
  accuracy.ts        scoring against known truth: CEP50 / CEP95, RMS, bias, sigma ratio
src/sim/           SANDTABLE: world, simulation engine, Three.js scene, HUD
src/live/          FTX pages: markers, observer, xrcheck; marker detection, sub-pixel corners,
                   FOV calibration, synthetic test images, WebSocket transport
src/vendor/        js-aruco2 marker detector (MIT), as ES modules
server/relay.ts    FTX WebSocket relay
tools/accuracy.ts  accuracy report from the observer's recorded points (npm run accuracy)
tests/             vitest suites
docs/protocol.md   language-neutral message format
```

The simulator and the WebSocket relay implement the same `Transport` interface, so the mesh and fusion logic
is written and tested once.

## Accuracy

Marker position from one webcam, measured on synthetic images (1280 x 720, 65 degree field of view, ideal lens,
15 cm marker standing upright; a real webcam will do somewhat worse):

| Distance from the camera | 2 m | 3 m | 4 m | 5 m | 6 m | 7 m |
|---|---|---|---|---|---|---|
| RMS error | 0.3 cm | 1.0 cm | 2.9 cm | 4.1 cm | 4.2 cm | 8.9 cm |

Depth comes from the marker's apparent size, so its error grows with the square of the distance; a bigger
marker helps proportionally. The observer reports this expected error with every sighting.

- A field of view that is 1 degree off scales every distance by about 2%, which is 10 cm at 5 m.
- One degree of heading error costs about 9 cm at 5 m.
- Phone motion tracking drifts as you walk; studies of smartphone AR report position errors above 10 cm.
- Outdoors, GPS alone is only good to 3 to 5 m.
