# M5 — Per-message Model Attribution

Date: 2026-08-13. Status: **done**.

M5 makes assistant replies carry the model and cost record that produced them.
The dashboard no longer estimates this client-side: it reads provider,
requested model, resolved model, and ledger cost from the gateway ledger through
the stored reply task.

## Implementation

- `conversation_messages.source_task_id` links a promoted assistant message to
  the durable reply task that created it.
- `ConversationReplyDriver` writes that source task id when it appends the
  assistant reply.
- `PostgresConversationStore.messages()` joins the linked task to
  `ai_gateway_attempts` and `ai_usage_events`, preferring the accepted finalized
  attempt, and returns provider/model/cost attribution with the message.
- The dashboard API validator accepts only well-shaped attribution and rejects
  malformed cost or task ids.
- Assistant bubbles render the attribution footer as provider, resolved model,
  and exact ledger cost.

## Owner-directed fixes carried in this milestone

- DeepSeek Pro is now first for `bulk_code`, `complex_backend`,
  `bounded_repair`, and orchestration. DeepSeek Flash remains the same-provider
  fallback before Codex and Claude.
- Runtime policy-selected routes now resolve back to concrete gateway policy
  routes, so policy overrides cannot bypass the versioned allowlist shape.
- Telegram run reports no longer suppress first-attempt generation successes.
  Every completed generation phase now reports worker model, tier, budget, and
  milestone context when those facts exist.
- The 44 previously skipped tests were enabled by running the suite with the
  real test database, Docker worker image, and scaffold gates. The full proof is
  now zero skips.

## Security Review

- Attribution is server-derived from durable task and gateway tables; the client
  cannot submit model or cost values.
- The lateral ledger join is scoped by `source_task_id` and only runs for
  messages that have one, so owner/system messages do not receive invented
  attribution.
- The dashboard validator fails closed on malformed attribution values before
  rendering them.
- The visible footer is plain React text, not HTML, so provider/model values
  cannot inject markup.
- The Docker worker no-skip path now uses the pinned verification image from
  policy instead of a mutable `postgres:16-alpine` tag.

## Validation

- `TEST_DATABASE_URL=... TEST_SCAFFOLD_GATES=enabled npm test` — passed,
  440 tests, 440 pass, 0 skips.
- `npm run typecheck` — passed.
- `git diff --check` — passed.
- `npm audit` — passed, 0 vulnerabilities.
- `npm run dashboard:test` — passed, 6 files / 48 tests.
- `npm run dashboard:build` — passed.
- `npm run build` — passed.
- `npm run format:check` — passed.
- `git diff --check` — passed.
- `node --import tsx scripts/verify-contract.ts CONTRACT-018` — passed.
- `node --import tsx scripts/resume-checkpoint.ts --check` — passed.
- `TEST_DATABASE_URL=... node --import tsx scripts/policy-canary.ts deepseek`
  — passed for `deepseek-v4-pro` and `deepseek-v4-flash`.

The M0 reference document already retains both mockup review links:

- Codex as orchestrator:
  `https://polyp-ui-review.heroikuroi.chatgpt.site/#deployment`
- Claude as orchestrator:
  `https://claude.ai/code/artifact/386ec810-0571-44ea-9fe8-68c47a880ac9`
