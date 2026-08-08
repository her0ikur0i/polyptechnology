# CONTRACT-005 evidence

Date: 2026-08-08

## Milestone evidence

- M1: ADR-0001 records the gateway boundary, concrete model policy, trust model,
  budget semantics, alias resolution, verification rule, and rejected alternatives.
- M2: PostgreSQL-backed idempotent reservations, dispatch/finalization states,
  immutable per-model usage, requested/resolved model provenance, response
  rejection accounting, and evidence-backed reconciliation.
- M3: digest-pinned Docker execution with no shell or network, read-only root,
  dropped capabilities, resource limits, isolated workspaces, literal ownership,
  symlink-resistant artifact reads, and SHA-256 manifests.
- M4: provider adapters, conservative unknown-outcome handling, bounded canaries,
  per-model auxiliary usage, verification-gated summaries, and recovery runbook.
- M5: unit regression, fresh PostgreSQL 17 migration/integration, real isolated
  Docker execution, dependency audit, scope verification, and adversarial review.

## Architecture and review decisions

The gateway is an in-process control-plane boundary rather than a network service.
This preserves one durable authority for policy, budgets, attempts, and usage while
avoiding a premature distributed system. Provider aliases never satisfy audit
identity: the requested concrete ID and the provider-reported resolved ID are both
retained. Where a CLI does not report the model, the pinned invocation is recorded
as `pinned_request`, never misrepresented as provider confirmation.

DeepSeek V4 Pro performed the independent gateway/worker review. Its actionable
finding—provider responses rejected after dispatch could otherwise lose billable
usage—was repaired by charging immutable usage before finalizing the attempt as
failed. Ambiguous calls with a provider request ID retain their reservation until
external reconciliation. Reconciliation without such an ID now requires a reason
and immutable evidence digest. Codex reviewed, integrated, and deterministically
verified the repairs. Claude repository-review attempts were bounded but did not
produce accepted findings; their failures were retained rather than presented as
progress.

## Final verification

- Strict TypeScript typecheck: passed.
- Deterministic suite with fresh PostgreSQL: 48 passed; only the separately-run
  Docker test was environment-gated in that invocation.
- PostgreSQL 17 migrations `0001` through `0004`: passed from an empty database.
- Real digest-pinned Docker worker integration: 1 passed, 0 skipped.
- DeepSeek live managed canary: exact output verified and summary-gated.
- Dependency audit: zero known vulnerabilities.
- Contract scope, diff hygiene, and secret scan: passed.
- No production, DNS, Telegram, secret mutation, Git publication by a worker, or
  generated-project mutation occurred.

## Provider and model summary

Accepted live canary:

- DeepSeek `deepseek-v4-flash`, role `bulk-coder`: attempt
  `e1a77fa1-42a1-49fe-9a0f-607ce80375cc`; 20 input, 7 output, 0 reasoning,
  0 cache tokens; USD 0.000005; succeeded; output SHA-256
  `fdc6781be28c17dab4bcdc9ca0c8465dd02d8c40292a08f09dcbb063aeed1bd8`;
  passed `literal-output-v1` verification.

Managed operational calls retained during implementation:

- DeepSeek `deepseek-v4-pro`, independent review: 19,134 input, 1,915 output,
  2,304 cache-read tokens; USD 0.008996; succeeded. Findings were independently
  triaged and accepted only after deterministic verification.
- Codex `gpt-5.6-sol`, integration probe: 14,145 input, 9 output, 11,008
  cache-read tokens; subscription accounting reported USD 0; succeeded with
  `pinned_request` resolution because the CLI emitted no provider model field.
- Claude `claude-sonnet-5`, bounded review probe: 552 input, 908 output, 16,275
  cache-read and 9,041 cache-write tokens; USD 0.073196 including separately
  attributed `claude-haiku-4-5-20251001` auxiliary usage. No output was accepted
  as contract progress because repository review did not complete its gate.

The operational probes preceded the final fresh database fixture and are retained
from managed execution records; the final canary above is the verification-gated
reference record for the completed gateway schema.
