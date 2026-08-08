# ADR-0004: Factory Live is a bounded read-only projection

- Status: accepted
- Date: 2026-08-08
- Contract: CONTRACT-008

## Decision

Factory Live is a browser-only Canvas 2D projection paired with an equivalent
semantic DOM tree. It consumes a validated, scope-filtered snapshot and ordered
incremental events. It exposes no workflow command interface. Selection changes
local inspection state only; navigation to authoritative source records uses
ordinary links outside the renderer.

Topology and activity are separate. A deterministic layout rebuild occurs only
when `structureVersion` changes. Activity events update node/edge presentation and
bounded particle queues without changing hierarchy. Event IDs are monotonic within
a stream: duplicates are ignored, gaps freeze incremental application and request a
fresh snapshot, and replay operates on an isolated projection rather than the live
workflow store.

The renderer caps accepted nodes, edges, particles, and device pixel ratio. A frame
budget controller moves among 30, 15, and 5 FPS using measured rolling frame time.
Rendering pauses while the document is hidden or canvas is offscreen. Reduced-motion
mode disables particles and continuous frames; a static semantic view remains fully
usable. Canvas hit testing may select a node but cannot execute an operation.

## Consequences

The view communicates real delegation and evidence flow without becoming a control
surface or consuming unbounded host resources. Canvas and DOM duplication adds
implementation effort, but it is necessary for accessibility, testing, degraded
devices, and operational truth.

## Rejected alternatives

- WebGL/3D engine: unnecessary dependency and GPU complexity for the initial host.
- Canvas-only labels and hit targets: inaccessible and hard to audit.
- Rebuilding layout for every event: unstable, expensive, and semantically wrong.
- Treating SSE as lossless: reconnects and proxies can create gaps.
- Animating stale/replayed data as live: materially misleading.
