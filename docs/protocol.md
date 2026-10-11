# CROSSCUE wire protocol (v0, draft)

Language-neutral description of what two nodes exchange. In CROSSCUE terms an Observation is a SPOTREP and
the mesh relay is RETRANS. The TypeScript reference is `src/core/types.ts`
and `src/core/mesh.ts`; a Kotlin port must behave the same.

## World frame W

- Right-handed, **+Y up**, metres.
- A heading ("yaw") of 0 faces **-Z**; positive yaw turns counter-clockwise seen from above (same as Three.js).
- W is defined by a printed origin marker: origin at its centre, +X along its right-hand edge, Y up.
  Gravity is shared by every device's IMU, so a device's local frame is related to W by 4 unknowns only:
  translation (x, y, z) and yaw.

## Observation

A single sighting, **already in W**. Receivers never see anything relative to the observer.

| Field | Type | Meaning |
|---|---|---|
| origin | string | node id of the observer |
| seq | uint | per-origin counter; `(origin, seq)` identifies the message |
| t | number | observer clock, ms. Not synchronised between devices; do not use it for ageing |
| label | string | class, e.g. `person`, `tag` |
| id | string? | stable identity if known (marker id, tracker id) |
| pos | [x, y, z] | metres in W |
| sigma | number | 1-sigma position uncertainty, metres; includes the observer's own pose uncertainty |
| vel | [x, y, z]? | m/s in W |

Target size: about 50 bytes in a compact binary encoding (the simulator uses JSON).

## Packet

| Field | Type | Meaning |
|---|---|---|
| ttl | uint | forwards still allowed; the observer sends with its configured TTL (default 4) |
| hops | string[] | path so far, origin first (diagnostics) |
| obs | Observation | payload |

## Mesh rules (managed flooding)

1. On publish: stamp `seq`, remember `(origin, seq)`, broadcast to all direct neighbours with `ttl = N`.
2. On receive: if `(origin, seq)` was seen, drop it. Otherwise remember it, deliver it to the application,
   and if relaying is enabled and `ttl > 0`, rebroadcast with `ttl - 1` and the hop list extended, to every
   neighbour except the one it came from.
3. The seen-set is bounded; the oldest ids are evicted first.

## Receiver behaviour

- Fuse by `id` (or by label and distance gate when no id): inverse-variance weighting of position, alpha-beta
  velocity, uncertainty growing with age.
- Age tracks by **local receive time**. Out-of-order messages are detected by `seq` per origin.
- Show tracks as stale after about 2.5 s without an update and drop them after about 10 s.

## Open questions (to settle with Stage 2 data)

- Clock offset estimation between devices, to compensate multi-hop latency for moving targets.
- Whether to add a re-anchor message (marker sightings shared between devices) to cancel drift jointly.
- Binary encoding (CBOR / protobuf) and a protocol version byte.
