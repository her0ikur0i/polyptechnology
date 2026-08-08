# CONTRACT-005 — Managed AI Gateway and isolated worker execution

Status: accepted

## Objective

Establish the mandatory, auditable AI execution boundary for DeepSeek, Codex, and
Claude, then execute bounded jobs in isolated workspaces with capability, artifact,
budget, recovery, and model-resolved usage integrity.

## Scope

- In-process AI Gateway with concrete model policy, discovery, routing, reservation,
  invocation, normalized usage, retry/escalation, and finalization.
- Durable immutable routing, provider request, usage, artifact, and verification
  provenance with requested and resolved model IDs.
- Managed adapters for DeepSeek HTTP, Codex CLI, Claude CLI, and deterministic fakes.
- Isolated local worker workspace contract, capability checks, output limits,
  artifact hashing, cancellation, timeout, and crash-safe recovery.
- Detailed architecture decisions and operational recovery documentation.

## Out of scope

Dashboard UI, production activation, live owner credentials in source, Kubernetes,
remote deployment, generated-project lifecycle, and autonomous conversations.

## Risks

Untracked spend, alias drift, duplicate billing, ambiguous provider outcome, secret
leakage, retry storms, workspace escape, untrusted output, and telemetry loss.

## Budget

Provider canaries are bounded to minimal output. Every managed call requires an
integer micro-dollar reservation and explicit attempt ceiling.

## Capability envelope

L0 inspection; L1 owned workspace mutation and isolated fixtures; L2 bounded managed
provider canaries and review. No production, DNS, destructive, or secret mutation.

## Milestones

1. M1: architecture decision, concrete model catalog, execution and integrity policy.
2. M2: durable gateway ledger, reservation/finalization, adapters, normalized usage.
3. M3: isolated worker contract, capabilities, artifacts, timeout, cancellation.
4. M4: recovery, reconciliation, escalation, provider canaries, summaries.
5. M5: independent review, regression, evidence, final gates.

## Gates

- No provider-attributed work bypasses the gateway.
- Requested and resolved model IDs, policy version, attribution, usage, and outcome
  are complete or explicitly fail closed.
- Duplicate idempotency and ambiguous outcomes cannot double-spend or auto-retry.
- Workspace traversal, undeclared capabilities, oversized artifacts, and unsafe
  process invocation fail before execution.
- Locked install, typecheck, tests, PostgreSQL integration, scope, audit, diff, and
  secret scan pass.

## Acceptance

- All three provider adapters produce the same normalized attempt record.
- Concrete IDs drive routing; aliases are metadata only and cannot satisfy resolved ID.
- Every task summary reports provider/model/role/usage/cost/result/artifacts/gates.
- Isolated attempts cannot write outside their assigned workspace or publish Git.
- Recovery distinguishes safe retry from unknown external outcome.

## Evidence

Recorded in `docs/contracts/CONTRACT-005/evidence.md`.

## Rollback

Revert the single contract commit before adoption; migration is not applied to
production in this contract.

## Completion policy

All gates pass before exactly one commit and push, then continue to CONTRACT-006.

## File ownership

- `README.md`
- `package.json`
- `package-lock.json`
- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/contracts/CONTRACT-005/**`
- `docs/operations/**`
- `migrations/**`
- `scripts/**`
- `src/**`
- `tests/**`
