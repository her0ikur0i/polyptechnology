# ADR-0006: PostgreSQL owns operational truth; the service manager owns restart

- Status: accepted
- Date: 2026-08-08
- Contract: CONTRACT-010

## Decision

Background execution is a non-interactive process with two distinct loops. The
sequence loop holds a fenced roadmap lease, checkpoints contract/milestone progress,
and emits summaries. The work loop claims already-authorized eligible tasks, runs a
bounded driver, renews its task lease, verifies evidence, and records terminal state.
Holding a sequence lease alone is never reported as execution progress.

PostgreSQL is authoritative for leases, fences, checkpoints, incidents, health
observations, backup manifests, and retention plans. systemd only starts/restarts a
process and applies OS containment. A crash can cause replay of computation, but
idempotency keys and fenced writes prevent duplicate authoritative mutation.

Health endpoints and local checks use database/service state and never call paid
models. Structured events use stable low-cardinality names and bounded attributes;
secret-like keys and values are rejected. Incidents deduplicate by fingerprint and
follow new -> seen -> acknowledged -> resolved with actor/timestamp evidence.

Backups are immutable artifacts described by a manifest containing source database,
migration head, creation time, size, SHA-256, encryption/key references, and covered
domains. Secret material is backed up separately as encrypted provider-owned data;
the application backup contains references only. Restore always targets a clean
database and validates manifest digest before import and application invariants
after import.

## Consequences

Closing an interactive Codex terminal no longer has to stop already-authorized
queued execution after the service is explicitly installed and activated. It still
cannot invent contracts, approve risk, deploy, or resolve owner decisions. Those
authority boundaries remain durable and visible.

## Rejected alternatives

- Treating a terminal or chat goal as the service supervisor: not durable.
- Reporting heartbeat-only service state as sequence progress: materially false.
- Paid model canaries as health checks: costly and failure-amplifying.
- Restoring over a live database: destructive and difficult to verify.
- Logging arbitrary provider payloads: leaks secrets and creates unbounded data.
