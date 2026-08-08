# CONTRACT-006 — Persistent orchestrator and conversation workspace

Status: accepted

## Objective

Provide a durable, restart-safe owner conversation and context-engineering layer
that may propose bounded work but can never bypass approved contracts, capabilities,
the managed AI Gateway, or deterministic verification.

## Scope

- Durable conversations, messages, attachments, context manifests, and proposals.
- Explicit trust classification, redaction boundaries, immutable message history,
  scoped idempotency, optimistic concurrency, and bounded context selection.
- Orchestrator state transitions from draft proposal through owner review and
  approved-contract handoff without treating chat as execution authority.
- Persistent sequence supervisor with durable checkpoints, leases, heartbeat,
  bounded recovery, automatic milestone/contract advancement, and owner-blocker
  aggregation. A reproducible systemd unit runs the controller under a dedicated
  identity with restart and resource limits; task execution remains delegated to
  the existing isolated worker boundary.
- Upload metadata validation and isolated-processing requests; no raw upload is
  exposed to a provider before scan and classification gates pass.
- Architecture, recovery, retention, and operational evidence.

## Out of scope

Dashboard UI, project generation, public production activation, arbitrary file
extraction, vector embeddings, deployment, DNS, and secret mutation.

## Risks

Prompt injection, authorization confusion, cross-project disclosure, context
overflow, mutable history, duplicate proposals, attachment malware, and restart
duplication.

## Budget

Deterministic implementation is preferred. Any provider call uses CONTRACT-006
gateway attribution, explicit output/cost ceilings, and verification-gated summary.

## Capability envelope

L0 inspection; L1 owned source, documentation, tests, and isolated PostgreSQL
fixtures; L2 bounded managed provider review. No production or irreversible action.

## Milestones

1. M1: conversation/context ADR, trust model, schema, and domain invariants.
2. M2: durable repository, immutable history, idempotency, and concurrency.
3. M3: bounded context compiler, redaction, attachment quarantine workflow.
4. M4: proposal lifecycle and approved-contract handoff boundary.
5. M5: persistent supervisor, heartbeat, recovery, auto-advance, and service units.
6. M6: restart/integration/security review, evidence, and final gates.

## Gates

- Chat content cannot authorize execution or alter an accepted contract.
- Every query and context item is project/conversation scoped and classified.
- Secrets and unscanned attachment contents cannot enter model context.
- Duplicate message/proposal requests are replay-safe; stale writers fail closed.
- Process exit, host restart, provider timeout, and expired lease resume from a
  durable checkpoint without duplicating a terminal task or skipping a gate.
- Sequence advancement stops only at a declared owner-only blocker, exhausted
  policy, failed final gate, or completed roadmap; ordinary failures retry or
  recover within explicit limits.
- Locked install, typecheck, tests, migration fixture, audit, scope, diff, and
  secret scan pass.

## Acceptance

- Conversation and proposal state survive repository reconstruction.
- Context compilation is deterministic, bounded, provenance-preserving, and
  excludes ineligible classifications.
- Handoff emits an immutable contract candidate only after an approval reference;
  it does not enqueue work or grant capabilities.
- Attachment lifecycle requires validation, scan, classification, and redaction
  before eligibility.
- A supervised worker can restart, reclaim expired work, advance the next eligible
  milestone/contract, and produce a compact provider/model tracking summary.

## Evidence

Recorded in `docs/contracts/CONTRACT-006/evidence.md`.

## Rollback

Revert the single contract commit before adoption; migration is additive and is
not applied to production by this contract.

## Completion policy

All gates pass before exactly one commit and push, then continue to CONTRACT-007.

## File ownership

- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/contracts/CONTRACT-006/**`
- `docs/operations/**`
- `migrations/**`
- `scripts/**`
- `src/orchestrator/**`
- `deploy/systemd/**`
- `tests/**`
