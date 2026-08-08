# CONTRACT-008 — Adaptive Factory Live View and event replay

Status: accepted

## Objective

Render real factory topology and immutable event replay as an adaptive, accessible,
non-authoritative Canvas 2D visualization integrated into the Master Dashboard.

## Scope

- Typed topology snapshot and incremental event/replay contracts with validation.
- Modular Canvas 2D renderer for factory, project, contract, milestone, agent,
  task/file/evidence hierarchy and delegation/result flow.
- Structure-versioned graph layout, level of detail, bounded nodes/particles,
  frame-time adaptation, DPR cap, 30/15/5 FPS modes, offscreen/hidden pause,
  reduced-motion/static representation, and recovery polling semantics.
- Semantic DOM summary/drill-down paired with canvas; visualization never mutates
  workflow state.
- Dashboard Factory Live route, component/renderer/replay/accessibility tests,
  performance evidence, architecture, and operational documentation.

## Out of scope

WebGL, workflow control from canvas, project generation, production deployment,
DNS, secrets, and unbounded historical rendering.

## Risks

Misleading animation, runaway CPU/memory, inaccessible canvas-only information,
event gaps/reordering, cross-project disclosure, stale topology, replay mutation,
and visualization accidentally becoming an authority surface.

## Budget

DeepSeek is the primary renderer worker. Claude performs bounded visual/
accessibility review when available. Managed summaries track concrete models.

## Capability envelope

L0 inspection; L1 owned dashboard/source/test changes and local builds; L2 bounded
provider implementation/review. No production or external mutation.

## Milestones

1. M1: Factory Live ADR, topology/event schemas, validation, authority boundary.
2. M2: deterministic hierarchy layout and adaptive Canvas renderer.
3. M3: snapshot/SSE/replay state, gap recovery, pause and reduced-motion modes.
4. M4: dashboard integration, semantic drill-down and static accessible view.
5. M5: renderer/state/component/performance tests and production build.
6. M6: independent review, remediation, evidence, final gates.

## Gates

- Rendering accepts only validated, project-scoped, bounded topology/events.
- Canvas and replay cannot dispatch commands or mutate workflow.
- Hidden/offscreen/reduced-motion states stop continuous animation.
- Event order, duplicates, gaps, stale snapshots, and reconnects are explicit.
- Semantic DOM exposes equivalent hierarchy/state without relying on color/motion.
- Locked install, typecheck, tests, build, audit, scope, diff, and secret scan pass.

## Acceptance

- Real snapshot plus ordered incremental events update only affected visual state.
- Topology layout rebuilds only when structure version changes.
- Renderer adapts detail/frame rate to budget and caps DPR/nodes/particles.
- Owner can inspect hierarchy and replay position without using canvas.
- Visualization remains read-only under all interaction paths.

## Evidence

Recorded in `docs/contracts/CONTRACT-008/evidence.md`.

## Rollback

Revert the single contract commit; no production deployment occurs.

## Completion policy

All gates pass before exactly one commit and push, then continue to CONTRACT-009.

## File ownership

- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/contracts/CONTRACT-008/**`
- `src/dashboard/**`
- `tests/dashboard/**`
