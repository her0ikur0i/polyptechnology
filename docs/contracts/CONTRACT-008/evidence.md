# CONTRACT-008 evidence

Date: 2026-08-08

## Milestone evidence

- M1: ADR-0004 fixes Factory Live as a bounded, read-only projection and separates
  topology structure, activity, replay, and workflow authority.
- M2: strict snapshot/event types, project-scope validation, deterministic radial
  layout, structure-version topology cache, viewport-only coordinate scaling,
  Canvas 2D renderer, DPR/graph/particle caps, and adaptive 30/15/5 FPS budget.
- M3: stream-specific monotonic projection, duplicate suppression, explicit gap
  freeze, isolated replay, one in-flight recovery snapshot, reconnect cleanup,
  visibility/intersection/reduced-motion/stale pause semantics.
- M4: responsive `/factory-live` route, local-only inspection, internal source
  links, canvas fallback text, and a semantic hierarchy carrying every node's
  label, kind, and textual state.
- M5: validation, replay, cache, hit-test, frame-budget, component, read-only,
  stale-state, and accessibility coverage plus strict build verification.
- M6: Claude specialist review, DeepSeek final independent review, remediation,
  managed-attempt verification, scope and publication gates.

## Architecture and review decisions

DeepSeek V4 Pro supplied the initial complex renderer/event blueprint and V4 Flash
acted as the primary bounded implementation worker. Codex integrated only guidance
consistent with the approved contract; in particular it rejected suggested caps
that contradicted the contract and routing patterns unrelated to the existing
React Router shell.

The implementation treats viewport resize as coordinate scaling of an already
built topology, not a topology rebuild. Only a changed `structureVersion` increments
the topology build count. Activity never changes hierarchy. A stale snapshot is
labelled and cannot animate as live. Stream gaps, malformed data, and transport
errors trigger one deduplicated snapshot recovery while the old connection is
closed during replacement.

Integration review additionally found and repaired two disclosure/navigation
edges: non-factory nodes now require an authorized `projectId`, and protocol-relative
`//host` links are rejected rather than accepted as internal paths. Timestamp
validation and explicit stale rendering were also added.

Claude Sonnet 5 completed the specialist security/accessibility review and reported
no supported critical/high findings. DeepSeek V4 Pro then returned `NO
CRITICAL/HIGH FINDINGS` in the bounded final independent review.

## Final verification

- Strict TypeScript typecheck: passed.
- Existing backend/deterministic suite: 55 tests discovered, 51 passed and four
  unchanged environment-gated integration tests skipped.
- Dashboard suite: 16 passed across five files, including automated semantic
  accessibility scan with jsdom color contrast excluded.
- Production Vite build: passed; JS 265.12 kB / 85.07 kB gzip, CSS 8.66 kB /
  2.79 kB gzip, HTML 0.44 kB / 0.28 kB gzip.
- Managed implementation/review artifact SHA-256:
  `77bff366f86e69e8ead993defb9fc397bb38d9e90fdd671be184e92ed8bd220c`.
- No workflow command, public deployment, DNS, secret value, or generated-project
  mutation occurred.

## Provider and model tracking

- DeepSeek `deepseek-v4-pro` thinking, role `backend-coder`: attempt
  `725a2fde-e305-46ed-bce8-53a154a1b9ea`; 148 input, 4,850 output, 557 reasoning,
  zero cache tokens; USD 0.004284; succeeded and gate-verified.
- DeepSeek `deepseek-v4-flash` non-thinking, role `bulk-coder`: attempt
  `33bcf9bc-6b07-4889-a244-ee2dab205d74`; 201 input, 2,548 output, zero
  reasoning/cache tokens; USD 0.000742; succeeded and gate-verified.
- Claude `claude-sonnet-5` high effort, role `specialist-reviewer`: attempt
  `93ba8e75-735a-4678-b422-731e92d86fc1`; Sonnet slice 2 input, 4,370 output,
  22,098 cache-read, 3,718 cache-write tokens and auxiliary
  `claude-haiku-4-5-20251001` slice 877 input/20 output; USD 0.095471 total;
  succeeded with no critical/high findings and was gate-verified.
- DeepSeek `deepseek-v4-pro` non-thinking, role `independent-review-fallback`:
  attempt `0a44d1e4-36d8-4ca0-825c-5fa02c2e62e4`; 261 input/8 output, zero
  reasoning/cache tokens; USD 0.000121; succeeded with no critical/high findings
  and was gate-verified.
- Claude attempt `0c63d2ba-4349-486d-92f1-bbee9e5755d4` reached its bounded
  max-turn limit after provider dispatch and returned no review result. It remains
  correctly recorded as `outcome_unknown` with its reservation retained pending
  external reconciliation; it was not counted as progress or usage.
- Codex orchestrated, rejected inconsistent suggestions, integrated bounded fixes,
  and executed deterministic gates. No separately metered Codex Gateway inference
  was required, so application-ledger Codex tokens/cost are zero.

Total known managed-provider cost: USD 0.100618. The ambiguous Claude reservation
is excluded because the provider returned no attributable usage envelope.
