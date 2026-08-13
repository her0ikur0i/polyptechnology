# CONTRACT-019 Evidence — Managed DeepSeek Budget Bootstrap

## Status

Complete.

This evidence records a workflow bug found during the owner-requested test pass:
the managed DeepSeek path could fail before reaching DeepSeek.

## Finding

`scripts/managed-deepseek-task.ts` called `AiGateway.execute()` with
`MANAGED_CONTRACT_ID`, but did not ensure an `ai_budget_accounts` row existed
for that contract.

`PostgresAttemptLedger.reserve()` reserves by
`ai_budget_accounts.scope_id = attribution.contractId`. With no row, the
reservation update affects zero rows and throws:

`gateway budget unavailable or exhausted`

That broke the CONTRACT-019 operating model because new bounded frontend tasks
could not be handed to DeepSeek without manual database seeding.

## DeepSeek Use

After confirming the missing budget row, a bounded local test budget row was
seeded for `CONTRACT-019` and the managed DeepSeek route was retried.

DeepSeek call:

- Script: `scripts/managed-deepseek-task.ts`
- Contract: `CONTRACT-019`
- Milestone: `M5`
- Task class: `bulk_code`
- Provider/model: `deepseek / deepseek-v4-pro`
- Attempt id: `909fba48-3ab2-4425-befd-2246cb3299ac`
- Outcome: succeeded
- Usage: 173 input, 869 output, 0 reasoning, 0 cache, $0.000832

DeepSeek correctly identified the missing budget bootstrap, but its suggested
column names were generic and did not match this repository. Codex performed the
planned integration/review step using the actual schema.

## Fix

Changed:

- `scripts/managed-deepseek-task.ts`
- `tests/managed-deepseek-task.test.ts`

Implementation:

- exported `ensureManagedBudgetAccount()`;
- inserted
  `ai_budget_accounts(scope_id, max_cost_usd_micros) VALUES ($1, $2) ON CONFLICT (scope_id) DO NOTHING`;
- called the helper before creating/executing the gateway request;
- added an import guard so the helper can be tested without invoking DeepSeek;
- added a regression test proving the helper creates a missing row and does not
  overwrite existing `spent_usd_micros`, `reserved_usd_micros`, or
  `max_cost_usd_micros`.

## Validation

Commands run:

- `TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test node --import tsx --test tests/managed-deepseek-task.test.ts`
  - passed, 1 test
- `npm run typecheck`
  - passed
- `npm run format:check`
  - passed
- `TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 TEST_SCAFFOLD_GATES=enabled npm test`
  - passed, 445 tests, 0 skipped

Earlier in the same test pass, before this fix:

- `npm run dashboard:test`
  - passed, 52 tests
- `npm run dashboard:build`
  - passed

## Result

Future bounded implementation briefs can be routed through managed DeepSeek for a
new contract without a manual budget-account preflight. Codex remains in the
planned role: strategy, review, integration, and verification.
