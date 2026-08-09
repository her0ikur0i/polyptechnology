# M1 — Fail-closed routing with owner-scoped role exchange

Status: done, evidenced 2026-08-09 (initial cut 2026-08-08, extended by Amendment 1)

## What changed

- `src/gateway/model-policy.ts`: removed Codex from `bulk_code` /
  `complex_backend` / `bounded_repair` as a bare "hard-fallback"/"integrator"
  route (2026-08-08 cut), then (Amendment 1, 2026-08-09) reintroduced Codex as
  an explicit, evidence-gated middle fallback tier: deepseek -> codex -> claude.
  `MODEL_POLICY_VERSION` is `2026-08-09.1`.
- `src/policy/execution-permission.ts`: `technicalExecutionAllowed` now branches
  on `deepseek` (always), `codex` (verified DeepSeek failure or manual owner
  override), `claude` (verified DeepSeek _and_ Codex failure -- fallback of the
  fallback).
- `src/policy/validate-policy.ts`: provider allowlist extended to
  `deepseek | codex | claude`; ordering check generalized from a 2-tier
  deepseek-before-claude rule to a 3-tier monotonic-cost rule.
- `docs/contracts/CONTRACT-011/contract.md`: Amendment 1 records the
  owner-authorized Claude/Codex strategic role exchange and the 3-tier chain,
  superseding the original "Codex requires explicit override only" clause.

## Test evidence

`tests/gateway.test.ts`, `tests/policy-permission.test.ts`,
`tests/policy-routing.test.ts` updated for the 3-tier chain. Full suite run
against a fresh disposable Postgres (`polyp-contract011-pg`, migrations
0001-0008 applied clean):

```
# tests 98
# pass 97
# fail 0
# skipped 1   (pre-existing Docker-capability test, unrelated to this change)
```

## Live synchronization evidence

`scripts/policy-canary.ts` executed live against all 8 distinct
`(provider, requestedModelId)` routes registered under `2026-08-09.1`:
`deepseek-v4-flash`, `deepseek-v4-pro`, `gpt-5.6-terra`, `gpt-5.6-sol`,
`claude-sonnet-5`, `claude-opus-5`, `claude-haiku-4-5-20251001`,
`claude-opus-4-8` -- all 8 round-tripped cleanly (raw output in
`/tmp/claude-0/-root/27650564-015a-4202-bcdd-9339f3c82486/scratchpad/policy-canary-full-run.json`
for this run; re-run before every future policy activation, don't rely on a
stale copy).

The canary run also reproduced and explained the earlier `m1-deepseek-pro.json`
empty-attempt failure from the pre-Amendment session: `deepseek-v4-pro`
thinking-mode spends part of `maxOutputTokens` on reasoning before any answer
text; a too-tight budget starves `content` to empty and fails
`invalid_provider_accounting`. Not an adapter defect -- production routes
already use much larger budgets (e.g. 6000 in `managed-deepseek-task.ts`).
