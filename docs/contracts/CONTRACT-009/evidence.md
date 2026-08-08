# CONTRACT-009 evidence

Date: 2026-08-08

## Milestone evidence

- M1: ADR-0005 defines versioned blueprint authority, dynamic project isolation,
  guarded lifecycle effects, capacity admission, scoped reuse, and erasure.
- M2: strict blueprint parsing/hashing, immutable published content, UUID-derived
  project namespaces, idempotent project creation, fenced legal transitions, and
  immutable transition evidence are implemented in memory and PostgreSQL.
- M3: deterministic priority/aging selection and globally serialized persistent
  reservations enforce global/provider/project concurrency, budget, disk watermark,
  CPU, memory, disk, process, expiry, and stale-release fences.
- M4: provenance-rich knowledge lifecycle, exact scope-aware full-text retrieval,
  private promotion guard, supersession, source-linked indexes, and idempotent purge
  plans are implemented. Purge-plan creation immediately cuts off retrieval.
- M5: deterministic domain tests and a fresh PostgreSQL migration/reconstruction
  test prove lifecycle replay, invalid-transition rejection, capacity fencing,
  cross-project denial, promotion, restart persistence, and purge coverage.
- M6: Claude specialist review found a deletion/retrieval exposure window. It was
  repaired and regression-tested; final DeepSeek review found no critical/high issue.

## Architecture and review decisions

DeepSeek V4 Pro supplied the primary complex schema/domain analysis and V4 Flash
provided the bounded implementation checklist. Codex integrated the useful locking,
scope, and lifecycle ideas while rejecting worker suggestions that would collapse
project and blueprint identity or physically delete data inside purge preparation.

Blueprints are structured data, never prompt authority. Published content is
immutable; a published version may only become superseded without changing its
identity, content, hash, or timestamps. Projects contain dynamic references and do
not add dashboard modules. Risk-state transitions record approval references but
perform no external effects in this contract.

Claude Sonnet 5 identified one critical issue: preparing a deletion marked derived
indexes but left the reusable source retrievable until later physical erasure. Both
memory and PostgreSQL retrieval now exclude any item with a purge plan immediately.
Purge preparation is idempotent, all derived indexes are covered atomically, and
the physical operation remains safely approval-gated. DeepSeek V4 Pro independently
re-reviewed the remediation and returned `NO CRITICAL/HIGH FINDINGS`.

## Final verification

- Fresh disposable PostgreSQL database applied migrations 0001 through 0006 with
  `ON_ERROR_STOP`; all statements passed.
- Strict TypeScript typecheck: passed.
- Backend/domain suite with PostgreSQL: 61 tests discovered, 60 passed; the unchanged
  Docker isolation test remained environment-gated.
- Dashboard suite and production build remain part of the final repository gate.
- Managed implementation/review artifact SHA-256:
  `662d2a18b4e9d8a7894c9a278feb7857baa97537f7356824514e21c9168f1f71`.
- No external repository, workspace, database namespace, secret, DNS, deployment,
  production transition, or destructive purge was executed.

## Provider and model tracking

- DeepSeek `deepseek-v4-pro` thinking, role `backend-coder`: attempt
  `149622b3-1e68-4e42-867f-313b4a62a5e3`; 241 input, 6,000 output, 3,834
  reasoning, zero cache tokens; USD 0.005325; succeeded and gate-verified.
- DeepSeek `deepseek-v4-flash` non-thinking, role `bulk-coder`: attempt
  `93b17bb5-c38f-4c8b-9062-79e62fd48aa6`; 107 input, 2,592 output, zero
  reasoning/cache tokens; USD 0.000741; succeeded and gate-verified.
- Claude `claude-sonnet-5` high effort, role `specialist-reviewer`: attempt
  `8ddd0b2a-cd62-42b1-bc69-a58a347bc7c7`; Sonnet slice 2 input/6,497 output,
  16,275 cache-read/9,485 cache-write tokens; auxiliary
  `claude-haiku-4-5-20251001` slice 866 input/16 output; USD 0.160200 total;
  succeeded, identified one critical finding, and passed remediation verification.
- DeepSeek `deepseek-v4-pro` non-thinking, role `independent-review-fallback`:
  attempt `6eb47fbd-68c4-4a16-ac92-6309dcd58652`; 218 input/8 output, zero
  reasoning/cache tokens; USD 0.000102; no critical/high findings and gate-verified.
- Codex orchestrated, integrated, remediated, and ran deterministic/fresh-database
  gates. No separate Codex Gateway inference was required; ledger cost is zero.

Total managed-provider cost: USD 0.166368.
