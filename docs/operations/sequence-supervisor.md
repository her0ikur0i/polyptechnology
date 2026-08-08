# Sequence supervisor operations

The sequence controller is a persistent, non-interactive process. PostgreSQL is
the source of truth for checkpoints, leases, retry ceilings, gate evidence, and
owner blockers. The service manager provides restart only; it cannot authorize or
advance work by itself.

## Runtime rules

- Claim one eligible unit using a fenced lease and renew its heartbeat.
- Resume the last durable checkpoint after restart; never infer completion from
  process exit or log text.
- Retry only provider outcomes known not to have completed. Ambiguous external
  outcomes remain reserved and require reconciliation.
- Advance a milestone only after its evidence gates pass and a contract only after
  its final gate and single publication checkpoint pass.
- Aggregate owner-only blockers and continue independent eligible work. Stop the
  roadmap only when no safe eligible work remains.
- Emit compact summaries containing contract/milestone, provider, concrete
  requested/resolved model, role, tokens, cache, cost, outcome, verification, and
  artifact/gate digests. Detailed stdout/stderr stays in bounded service logs and
  immutable evidence, not the conversation stream.

## Service safety

Units run under a dedicated unprivileged identity, load secret references from a
root-controlled environment file, use restart backoff and watchdog notification,
restrict filesystem and kernel access, and apply CPU/memory/process limits.
Installation and host activation occur only after CONTRACT-006 gates pass. Public
network exposure, production deployment, DNS, and secret changes remain separate
approval-controlled operations.
