# CONTRACT-006 evidence

Date: 2026-08-08

## Milestone evidence

- M1: ADR-0002 fixes the authority hierarchy: conversation is append-only scoped
  context; only an admitted approved contract and capabilities may authorize work.
- M2: PostgreSQL conversations, immutable messages, scoped idempotency, optimistic
  version fencing, proposals, and reconstruction-safe repositories.
- M3: deterministic bounded context manifests, secret exclusion, opaque attachment
  keys, admission bounds, quarantine/scan/classify/redact states, and immutable
  transition evidence.
- M4: owner-review and approval-referenced proposal state machine whose handoff is
  immutable data and has no work-engine or capability-granting dependency.
- M5: PostgreSQL sequence checkpoint, exclusive fenced lease, periodic heartbeat,
  expired-task recovery, graceful signals, hardened systemd unit, restart policy,
  watchdog notification, and compact-summary operations policy.
- M6: fresh migration/integration fixture, runtime shutdown/release exercise,
  dependency and systemd verification, managed independent review, remediation,
  and final gates.

## Architecture and integrity review

The supervisor is split deliberately: PostgreSQL owns workflow correctness and
systemd owns process liveness. A process restart grants no authority and cannot
convert ambiguous provider work into a retry. Context eligibility is computed
before provider routing and persisted as an immutable digest-addressed manifest.

Managed DeepSeek V4 Pro identified the long-running driver heartbeat and stale
checkpoint failure windows. The supervisor now renews during driver work, aborts
on heartbeat loss, checkpoints using the latest fenced lease, rejects re-entrant
same-owner claims, and releases on termination. Codex integrated the bounded
repair and verified it against the final deterministic suite.

Claude Sonnet 5 was selected for specialist review but its CLI exceeded the bounded
runtime and exited without a provider request identifier. The attempt was retained
as unknown, then reconciled to failed/no-charge with evidence rather than treated
as progress or blindly retried. The policy-selected independent fallback,
DeepSeek V4 Pro non-thinking, returned no critical/high findings; its result was
accepted only after the final test artifact passed verification.

## Final verification

- Strict TypeScript typecheck and production build: passed.
- Deterministic suite with PostgreSQL: 54 passed; the unchanged Docker worker test
  remained environment-gated and had already passed with its digest fixture in
  CONTRACT-005.
- PostgreSQL 17 migrations `0001` through `0005`: passed from an empty database.
- Orchestrator PostgreSQL reconstruction, attachment lifecycle, context manifest,
  stale fencing, heartbeat, and lease takeover tests: passed.
- Supervisor runtime SIGTERM released its database lease; hardened systemd unit
  passed `systemd-analyze verify`.
- Test artifact SHA-256:
  `fdd36aada293c4f91081db559533697859005915953a4bb9526565997584c5ca`.
- Dependency audit: zero known vulnerabilities.
- No public production, DNS, secret, Telegram, or generated-project mutation.
  Host installation remains a separate capability-controlled activation; the
  reproducible supervised runtime and unit are delivered and runtime-tested here.

## Provider and model tracking

- DeepSeek `deepseek-v4-pro` thinking, role `backend-coder`: attempt
  `50ba9f28-96a6-4096-9054-5463a31417b3`; 158 input, 6,000 output including 5,212
  reasoning tokens; cache 0; USD 0.005289; succeeded. Guidance drove the heartbeat
  and fencing repair; the earlier disposable database record is retained in the
  managed execution log summary.
- Claude `claude-sonnet-5`, role `specialist-reviewer`: attempt
  `fb9b37a5-24ad-4c88-93fd-d773a4f0be5b`; provider usage unavailable; USD 0;
  timed out before a provider request ID and was evidence-reconciled to failed.
  No finding or source change was accepted.
- DeepSeek `deepseek-v4-pro` non-thinking, role `independent-review-fallback`:
  attempt `81aee07c-64ff-492d-a568-f1170f4dd940`; 6,798 input, 8 output, 0
  reasoning/cache tokens; USD 0.002965; succeeded; resolved ID confirmed by the
  provider. A manifest-idempotency defect found during final integration was then
  repaired and the final review was repeated rather than relying on stale evidence.
- DeepSeek `deepseek-v4-pro` non-thinking, final independent re-review: attempt
  `995b7174-0c57-4f4c-b8bd-f6c6474bbf57`; 5,166 input, 8 output, 0
  reasoning/cache tokens; USD 0.002255; succeeded with no critical/high findings;
  passed `codex-final-gates-v1` verification against the final test artifact digest.
- Codex: orchestrated, integrated, and ran deterministic gates in the host session.
  No separate Codex Gateway inference was needed, so application-ledger tokens and
  cost are 0; host-session telemetry is not fabricated as provider usage.

Total metered managed-provider cost: USD 0.010509. The failed Claude attempt was
reconciled at zero because no provider request or usage record was emitted.
