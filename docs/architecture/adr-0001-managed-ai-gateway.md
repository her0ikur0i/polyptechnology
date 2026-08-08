# ADR-0001 — Managed in-process AI Gateway

Status: accepted for CONTRACT-005

## Context and decision drivers

Direct provider calls made CONTRACT-002 through CONTRACT-004 telemetry incomplete:
useful outputs existed, but the dashboard could not prove model resolution, tokens,
cost, retries, or accepted contribution. AI Factory requires reproducible routing,
strict budget integrity, provider independence, and task-level owner summaries.

## Decision

All managed inference crosses one in-process TypeScript AI Gateway. It is a bounded
module of the modular monolith, not a network microservice. It owns policy resolution,
budget reservation, durable attempt creation, provider invocation, response validation,
usage normalization, artifact provenance, verification status, and escalation.

The gateway records three distinct identities: policy route, requested concrete model
ID, and provider-resolved model ID. Aliases are optional display/input metadata and
never establish provenance. A missing or mismatched resolved ID is a failed attempt.

## Concrete initial model policy

- DeepSeek `deepseek-v4-flash`, non-thinking: bulk code and mechanical work.
- DeepSeek `deepseek-v4-flash`, thinking: first verification-driven escalation.
- DeepSeek `deepseek-v4-pro`, thinking: complex backend/concurrency bulk analysis.
- Codex `gpt-5.6-terra`: bounded structured repair and integration-light work.
- Codex `gpt-5.6-sol`: orchestration, hard integration/debugging, final gates.
- Claude `claude-haiku-4-5-20251001`: high-volume low-risk classification.
- Claude `claude-sonnet-5`: normal architecture/security/UI review.
- Claude `claude-opus-4-8`: difficult adversarial review at explicit `xhigh` effort.
- Claude `claude-opus-5`: exceptional high-risk long-horizon escalation only.

Availability is discovered per account. Policy cannot silently substitute a different
model. Changes require a versioned policy update and evaluation evidence.

## Integrity invariants

1. Durable attempt and conservative budget reservation precede external invocation.
2. One idempotency key identifies one immutable request intent.
3. Provider request IDs and usage events are immutable and unique when supplied.
4. Unknown external outcomes are not automatically retried without provider-level
   idempotency or reconciliation.
5. Completion cannot become accepted until resolved model, usage, output checksum,
   verification, and cost finalization are present.
6. Credentials are injected through secret resolvers and never persisted or logged.
7. Gateway failure cannot be bypassed by a direct call and still count as evidence.
8. Emergency stop and expired task lease prevent new invocation.

## Transaction and crash model

Reservation and attempt creation commit in a short transaction. No database lock is
held during inference. Finalization is a second transaction keyed by attempt and
provider request ID. A crash before dispatch safely releases a reservation; a crash
after dispatch becomes `outcome_unknown`; a received result can be reconciled by its
request ID. When reconciliation is unavailable, reservation remains conservative and
owner-visible rather than risking duplicate spend.

## Isolation boundary

Worker execution uses an explicit absolute workspace, literal owned paths, an
allowlisted executable/capability set, bounded environment, timeout, output size, and
artifact checksum. Provider output is untrusted input; it never authorizes host,
production, Git publication, DNS, or secret operations.

## Consequences

The initial gateway adds no network hop and uses the existing PostgreSQL authority.
It may later be extracted behind the same interfaces only when scaling or fault-domain
evidence requires it. Direct legacy calls remain documented but cannot satisfy future
managed-provider gates.
