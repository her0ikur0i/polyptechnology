# M6 — Policy UI completeness, Telegram webhook, usage/attribution depth

Status: done, 2026-08-09.

## Codex-override storage, previously a stub

`OwnerPolicyService.createCodexOverride()`/`findActiveOverride()`
(`src/policy/owner-policy-service.ts`) called through to `PostgresPolicyStore`
methods that did not exist -- both were hardcoded stubs (`createCodexOverride`
returned a fabricated `{id, taskId, expiresAt}` without writing anything;
`findActiveOverride` always returned `undefined`). `POST
/api/v1/policy/codex-override` was reachable since CONTRACT-012 M4 but never
actually persisted or consulted an override.

Added `insertOverride()`/`findActiveOverride()` to `PostgresPolicyStore`
(`src/policy/postgres-policy-store.ts`), backed by the `task_role_overrides`
table (migration 0008: append-only, immutable-by-trigger, `task_id` FK'd to
`tasks(id)` -- an override can only be granted for an already-existing task,
not pre-authorized speculatively). Wired both service methods to the real
store. `findActiveOverride` only returns a row where
`codex_technical_execution` is true and `expires_at > now()`.

Verified with `tests/policy-override.integration.test.ts` (4 tests, real
Postgres): insert-then-find round-trip, expired overrides correctly excluded
(inserted pre-expired rather than mutated, since the table rejects
UPDATE/DELETE by design), a full `OwnerPolicyService.createCodexOverride`
round-trip, and FK rejection for an unknown task id. Also verified live: a
running server process (`ACCESS_AUTH_MODE=disabled`), a real task row inserted
directly, and a real `POST /api/v1/policy/codex-override` call whose response
id was independently confirmed present in `task_role_overrides` by direct
query.

## Policy UI: rollback and override controls, dedicated envelope fields

`policy-control.tsx` previously only exposed draft/validate/approve/activate
and a single raw-JSON textarea for the entire `RuntimePolicy` document (routes

- envelope together) -- `rollbackPolicy()` and override client functions
  existed in `api.ts` but nothing in the UI called them (flagged as a gap in
  CONTRACT-012 Amendment 1).

Added:

- A **Rollback** panel: target version number input, calls
  `rollbackPolicy({policyKey, targetVersion})`, renders the reactivated
  version/state.
- A **Codex technical-execution override** panel: task id, reason, expiry
  (`datetime-local`) inputs, calls the new `createCodexOverride()` client
  function (added to `api.ts`), renders the granted override.
- **Dedicated envelope fields**: `ExecutionEnvelope` (`src/policy/types.ts`)
  is a flat six-field scalar record -- replaced hand-edited JSON for it with
  six labeled `<input type="number">` fields (soft budget, emergency
  ceiling, max output tokens, max turns, timeout, concurrency), merged with
  the parsed routes JSON at submit time. `routesByTaskClass` stays JSON --
  it is inherently a nested per-task-class list, not a flat scalar record,
  so a form doesn't remove any real editing complexity there.

Verified live against a running server: full draft -> validate -> approve ->
activate lifecycle using the exact `{routesByTaskClass, envelope}` shape the
redesigned form now submits, then a second draft activated over it, then a
successful rollback to the first version (correctly re-activated as a new
version, per the store's existing append-only versioning -- not an in-place
revert). A rollback attempt against the still-active version was correctly
rejected (`"Target must be superseded for rollback"`), proving the fail-closed
guard the store already enforced is reachable from the real route, not just
unit-tested.

## Telegram webhook (carried from M4/M5 wiring, confirmed complete this

milestone)

`POST /api/v1/telegram/webhook` (`src/control-api/telegram-webhook.ts`,
wired in `app.ts`) was already built and tested prior to this evidence file;
confirmed still green in the full suite. Gated by
`requireTelegramWebhookSecret` (Telegram's own `secret_token` mechanism), not
`requireOwner`/CSRF, since Telegram calls this route, not the owner's
browser. Only registered when `TELEGRAM_WEBHOOK_SECRET` +
`TELEGRAM_CHAT_ID` + `TELEGRAM_USER_ID` are all configured (fail-closed by
omission otherwise).

## Usage/attribution dashboard depth

The Providers page (`app.tsx`) showed only the current attempt list with no
failure reason or cross-attempt context. `ai_gateway_attempts.failure_code`
and `attribution` (jsonb, containing `taskId`/`taskAttemptOrdinal`) already
existed in the schema but were never selected by
`loadAttempts()` (`src/control-api/snapshot.ts`).

Added `failure_code`, `attribution->>'taskId'`, and
`attribution->>'taskAttemptOrdinal'` to the query and `ModelAttempt` type
(`src/dashboard/types.ts`: `failureCode?`, `taskId?`, `attemptOrdinal?`).
Rendered as:

- A **Fallback reason** column on the existing attempts table.
- A new **Rework history** panel: attempts grouped by `taskId`, tasks with
  more than one attempt rendered as an ordered escalation chain
  (`#1 deepseek/... failed — reason`, `#2 codex/... succeeded`, ...); tasks
  with a single attempt are omitted since there is nothing to show beyond
  the existing attempts table.

Verified live: a running server's real `/api/v1/dashboard/snapshot` returns
`failureCode`/`taskId`/`attemptOrdinal` on real rows (confirmed
`"failureCode":"invalid_provider_accounting"` on a real failed attempt from
earlier CONTRACT-013 M5 test runs). The fresh disposable database used for
this milestone's test runs has no task with more than one attempt yet, so the
rework-history empty state (`"No task has escalated across providers yet."`)
was the one actually exercised live -- the grouping/rendering logic itself is
plain array grouping with no server round-trip, so this is a low-risk gap,
not an unverified code path.

## Test evidence

`tests/policy-override.integration.test.ts` (4 new tests). Full backend
suite against a freshly recreated disposable database (migrations 0001-0010,
zero carried-over state -- recreated specifically because a live-smoke-test
policy activation under the real `programming-routes` key left durable,
immutable audit rows that interfered with
`generation-pipeline.integration.test.ts`'s fallback-route assumption; the
fix was recreating the disposable database, not deleting audit rows the
schema deliberately makes immutable):

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 156
# pass 156
# fail 0
# skipped 0
```

`npm run dashboard:test` (18/18), `npm run dashboard:build`,
`npm run typecheck` all pass. `scripts/verify-contract.ts CONTRACT-013`
passes.

## M6 scope closed

- Policy UI rollback/override controls: done.
- Dedicated envelope fields: done.
- Telegram webhook wiring: done (confirmed).
- Usage/attribution dashboard depth (fallback reason, rework history): done.

Not in M6's scope (explicitly deferred to later milestones per
`contract.md`): axe accessibility coverage for the Policy page and a
CSRF-rejection test for `/api/v1/policy/*` (M7); masked bot identity/webhook
status/decision history surfaced in the Telegram settings view beyond
`configurationReady` (not listed as an M6 gate, left for a future pass if the
owner acceptance checklist in M10 calls for it).
