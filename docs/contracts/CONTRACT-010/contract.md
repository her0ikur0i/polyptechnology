# CONTRACT-010 — Operations, disaster recovery, hardening, and release acceptance

Status: accepted

## Objective

Complete the first-release operational plane: executable background supervision,
structured health/incident signals, reproducible CI gates, backup/restore proof,
data lifecycle controls, a dummy generated-project demo lifecycle, and a
requirement-by-requirement acceptance/cutover audit.

## Scope

- Durable non-interactive sequence execution driver that consumes eligible work,
  checkpoints evidence, heartbeats, recovers safely, and emits compact model-aware
  summaries while detailed logs remain bounded in service storage.
- Hardened systemd units and environment/runbook templates without embedding or
  activating production secrets, DNS, public endpoints, or deployments.
- Structured health, metrics, stale-signal, incident deduplication/lifecycle, and
  authenticated readiness contracts without paid health probes.
- Locked CI workflow for backend/dashboard/integration/migration/security/build
  gates using immutable/reproducible inputs where available.
- PostgreSQL backup manifest, integrity/encryption-boundary checks, clean-database
  restore verification, retention plan, and RPO/RTO evidence.
- Data retention/export/archive/deletion policy records and derived-index coverage.
- One synthetic dynamic project completing blueprint -> demo in disposable state.
- Full first-release and roadmap acceptance matrix, security review, operational
  documentation, and final Owner Action Bundle.

## Out of scope

Production activation, DNS changes, public exposure, secret creation/rotation,
real project deployment, destructive production deletion, paid connectivity probes,
and claiming high availability on a single host.

## Risks

False background progress, duplicate execution after restart, stale leases, leaked
logs/backups, untested restore, unauthenticated mutation, alert storms, unsafe
cutover, mutable CI dependencies, and acceptance claims based on indirect evidence.

## Budget

DeepSeek is the primary operations/test worker. Codex integrates, performs the
acceptance audit, and handles hard fallbacks. Claude performs bounded security/DR
review. Concrete model usage and verification are mandatory in final evidence.

## Capability envelope

L0 inspection; L1 owned code/tests/docs/workflows and disposable local databases;
L2 bounded managed-provider review. Host service activation, production resources,
secret changes, DNS, and irreversible actions require separate approval records and
remain in the final Owner Action Bundle.

## Milestones

1. M1: operations/DR ADR, threat model, acceptance evidence map.
2. M2: executable supervisor driver, structured telemetry, incidents, health.
3. M3: CI/security pipeline and hardened service/runbook artifacts.
4. M4: backup/restore, retention, privacy, and clean-environment recovery proof.
5. M5: synthetic blueprint-to-demo lifecycle and full acceptance audit.
6. M6: independent reviews, remediation, final gates, cutover bundle.

## Gates

- Supervisor performs eligible work rather than merely holding a lease; restart and
  stale-writer tests prove checkpoint/resume without duplicate mutation.
- Health is free/read-only; mutations require owner authentication, CSRF, policy,
  capability, approval, and audit as applicable.
- Logs, incidents, summaries, and backup manifests exclude secret values and bound
  cardinality/size/retention.
- A fresh restore recreates verified durable state and checks migration/version,
  row-count/digest invariants, RPO/RTO targets, and corrupt-backup rejection.
- CI runs locked install, typecheck, unit/integration/migrations, dashboard/a11y,
  dependency/secret checks, build, and contract scope gates.
- Every first-release acceptance item has direct current-state evidence or is
  explicitly placed in the Owner Action Bundle; no weak proxy is marked passed.
- Locked install, full tests, build, audit, scope, diff, and secret scan pass.

## Acceptance

- Non-interactive supervision can execute and resume a deterministic queued unit and
  produce a compact provider/model-aware checkpoint without an interactive terminal.
- Clean disposable PostgreSQL restore passes integrity and application tests.
- Synthetic arbitrary project persists legal blueprint -> provisioned -> development
  -> demo transitions without external provisioning or hard-coded control-plane code.
- CI and operational artifacts are deployable after explicit owner approval.
- Final audit distinguishes verified release capabilities from owner-only cutover.

## Evidence

Recorded in `docs/contracts/CONTRACT-010/evidence.md` and the acceptance matrix.

## Rollback

Revert the single contract commit. Stop/disable a service only if it was separately
approved and activated; restore the prior immutable release and database backup.

## Completion policy

All non-owner gates and the complete Owner Action Bundle must pass before exactly
one commit and push. The roadmap goal completes only after a final evidence audit.

## File ownership

- `.github/workflows/**`
- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/operations/**`
- `docs/security/**`
- `docs/contracts/CONTRACT-010/**`
- `deploy/**`
- `migrations/0007_operations.sql`
- `scripts/**`
- `src/operations/**`
- `src/orchestrator/**`
- `src/work/postgres-repository.ts`
- `src/dashboard/**`
- `tests/dashboard/**`
- `tests/operations.test.ts`
- `tests/operations-postgres.integration.test.ts`
- `tests/release-acceptance.test.ts`
