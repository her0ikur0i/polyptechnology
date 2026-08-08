# CONTRACT-004 evidence

Date: 2026-08-08

## Milestone evidence

- M1: additive PostgreSQL hierarchy, task state machine, composite ownership
  constraints, immutable costs, attempts, leases, controls, and gate evidence.
- M2: scoped idempotency, monotonic fencing, heartbeat expiry, bounded retry,
  attempt history, reversible emergency stop, and worker-loss recovery.
- M3: idempotent post-hoc cost capture, task and contract budget cascades, durable
  gate reconciliation, and exclusive publication claims.
- M4: literal owned-path staging, `commit --only`, SHA-pinned push, crash recovery
  restricted to a single-parent owned commit, and durable publication checkpoints.
- M5: unit regression, real PostgreSQL 17 migration/integration, dependency audit,
  scope verification, independent adversarial review, and remediation.

## Independent review

Claude Opus reviewed the durable concurrency and publication paths. Review cycles
identified and drove repairs for reversible emergency handling, attempt recovery,
budget cascade, cost idempotency, publication crash windows, exclusive publication
claims, durable gate omission, SHA-pinned push, Git argument validation, and
reconciled-commit ownership. No reviewer-authored source was accepted directly;
Codex integrated each repair and deterministic verification covered the result.

These legacy review calls predate the managed AI Gateway and therefore lack a
trustworthy normalized token/cost ledger. They are retained as review evidence but
must not be used as the telemetry standard for later contracts.

## Final verification

- Strict TypeScript typecheck: passed.
- Deterministic suite: 37 passed, 1 environment-gated integration test skipped.
- PostgreSQL 17 migrations `0001` through `0003`: passed in an isolated fixture.
- PostgreSQL work-engine integration test: passed.
- Dependency audit: zero vulnerabilities.
- Diff hygiene and contract ownership: passed.
- No production, DNS, Telegram, secret mutation, or generated-project mutation.

## Provider summary

- Primary implementation and integration: Codex host session; resolved model ID
  was not exposed to the application ledger and is recorded as host-managed.
- Independent review: Claude Opus through the Claude Code subscription surface;
  exact resolved model and normalized token usage were not captured.
- DeepSeek: not used for CONTRACT-004. This policy deviation triggered the
  requirement that CONTRACT-005 introduce the mandatory managed AI Gateway before
  further provider-attributed contract work.
