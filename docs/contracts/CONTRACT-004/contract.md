# CONTRACT-004 — Durable work engine and atomic Git workflow

Status: accepted

## Objective

Create the deterministic contract/milestone/task/attempt engine, leases, recovery,
budgets, gates, evidence state, and safe single-publication Git protocol.

## Scope

- Domain hierarchy and validated state machines.
- Idempotent task submission, leases/heartbeats, retry classification, recovery,
  cancellation, emergency stop, and hierarchical budget checks.
- Additive PostgreSQL schema for durable contracts through attempts and evidence.
- Git publication planner that enforces baseline, ownership, final gates, scoped
  staging, exactly one commit, and exactly one push through an injected executor.
- Deterministic repositories/adapters and external-free tests.

## Out of scope

Real queues, isolated containers, provider execution, dashboard, deployment,
production migration, and autonomous conversation orchestration.

## Risks

Duplicate work, stale leases, invalid transitions, retry loops, budget overspend,
out-of-scope staging, overlapping ownership, and partial publication. Controls are
database uniqueness, compare-and-set transitions, expiry, normalized failures,
fail-closed budgets, resolved manifests, and command-array planning.

## Budget

No live inference or infrastructure is required. Runtime budgets use integer
micro-dollars and explicit blocked states.

## Capability envelope

L0 inspection; L1 owned workspace mutation and local Git test fixtures; L2 bounded
provider review. No production, DNS, secrets, destructive or irreversible action.

## Milestones

1. M1: hierarchy, lifecycle, schema, and invariants.
2. M2: idempotency, leases, retry, recovery, cancellation, emergency stop.
3. M3: hierarchical budgets, gates, and evidence requirements.
4. M4: atomic scoped Git publication planner/executor.
5. M5: independent review, regression, evidence, and final gates.

## Gates

- Invalid transitions, duplicate idempotency keys, stale leases, and unsafe retries fail.
- Budget exhaustion becomes explicit `budget_blocked` before spending.
- Emergency stop prevents new leases.
- Publication rejects failed gates, dirty out-of-scope paths, baseline drift,
  already-published contracts, and shell-interpolated commands.
- Locked install, typecheck, tests, scope, audit, diff, and secret scan pass.

## Acceptance

- Reconstructed state resumes without duplicate task execution.
- Expired leases can be safely reclaimed with a new fencing token.
- Authentication/policy/budget failures never enter automatic retry loops.
- A successful publication plan stages only owned paths and contains one commit/push.
- No Git mutation occurs in tests or from unvalidated model output.

## Evidence

Recorded in `docs/contracts/CONTRACT-004/evidence.md`.

## Rollback

Revert the single contract commit before adoption; migration is not applied to
production in this contract.

## Completion policy

All gates pass before exactly one commit and push, then continue to CONTRACT-005.

## File ownership

- `README.md`
- `package.json`
- `package-lock.json`
- `docs/RESUME.md`
- `docs/contracts/CONTRACT-004/**`
- `docs/operations/**`
- `migrations/**`
- `src/**`
- `tests/**`

Dirty paths outside this manifest block completion.
