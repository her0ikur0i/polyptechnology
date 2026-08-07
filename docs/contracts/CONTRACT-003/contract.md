# CONTRACT-003 — Provider registry, evaluation, and routing

Status: accepted — implementation and independent security review complete

## Objective

Create a durable, provider-neutral catalog and deterministic routing engine that
selects an eligible model for a bounded task and explains every decision.

## Scope

- Provider, account, model, capability, pricing-version, agent-role, evaluation,
  health, limit, and usage domain records plus additive PostgreSQL migration.
- Secret-reference-only accounts; no credential values in APIs/events/logs.
- Provider adapter contract with deterministic fake adapters and normalized errors.
- Eligibility filters, routing modes, ranking, fallback chains, estimates, and
  explicit budget-blocked outcomes.
- Golden-task evaluation aggregation and immutable usage attribution.
- Current manual execution policy for DeepSeek, Claude, and Codex documented as
  registry seed examples rather than hard-coded core behavior.

## Out of scope

Live provider activation, paid inference probes, secret mutation, dashboard UI,
job queues, workers, autonomous orchestration, deployment, and production data.

## Risks

Secret leakage, stale pricing, false capability claims, silent overspend, biased
self-evaluation, unhealthy fallback loops, and hard-coded providers. Controls are
reference-only credentials, effective-dated pricing, empirical scores, fail-closed
eligibility, bounded fallback, independent verification, and negative tests.

## Budget

Deterministic verification makes no paid inference calls. Design/review provider
calls are bounded and recorded in evidence. Runtime estimates never authorize
spend beyond the task ceiling.

## Capability envelope

L0 inspection; L1 owned workspace mutation; L2 locked dependency installation
and bounded provider egress for design/review. No L3–L5 action.

## Milestones

1. M1: contract, catalog types, lifecycle, and schema.
2. M2: adapter/error contracts and registry repository.
3. M3: eligibility, pricing, routing modes, ranking, and fallback.
4. M4: evaluation and usage attribution.
5. M5: security/recovery review, evidence, and integrated gates.

## Gates

- Locked install, strict typecheck, deterministic tests, and contract scope pass.
- Unknown/disabled/deprecated/unhealthy/incompatible/over-budget models are rejected.
- Routing is deterministic, explainable, provider-neutral, and never silently spends.
- Pricing uses the effective version for the request time and rejects gaps.
- Usage attributes provider/account/model/agent/project/contract/task/attempt.
- No credential value is persisted or emitted; staged secret scan is clean.
- Dependency audit and final staged diff checks pass.

## Acceptance

- All documented routing modes return a selection or an explicit blocked reason.
- Each result contains selected model, rejected candidates, estimate, and fallback.
- Empirical evaluation can override provider capability claims without mutating them.
- Registry reconstruction preserves catalog and immutable evaluation/usage records.
- Adding a fake new provider requires no core routing change.

## Evidence

Milestone and provider evidence is recorded in
`docs/contracts/CONTRACT-003/evidence.md`.

## Rollback

Revert the single contract commit before production adoption. The additive
migration is not applied to production by this contract.

## Completion policy

All milestones and final gates pass before exactly one scoped commit and push.
On publication, continue automatically to CONTRACT-004.

## File ownership

- `README.md`
- `package.json`
- `package-lock.json`
- `docs/RESUME.md`
- `docs/contracts/CONTRACT-003/**`
- `docs/operations/**`
- `migrations/**`
- `src/**`
- `tests/**`

Dirty paths outside this manifest block completion.
