# M10 — Owner acceptance checklist and testable scenarios

Status: done, 2026-08-09.

## Deliverable

`docs/contracts/CONTRACT-013/acceptance-checklist.md` -- a matrix mapping
each of `contract.md`'s six "## Acceptance" bullets to a status (Verified /
Partially verified / Pending M11) and direct evidence, plus six testable
scenarios the owner can run by hand against the M9 private staging
instance without editing any server file.

## A real gap closed, not just documented

Building the checklist surfaced that acceptance bullet 3 ("Telegram
approval delivery and decision are both observable and testable from the
dashboard, not just the settings form") was not actually true yet --
M6 evidence had explicitly deferred it, flagging it for "a future pass if
the owner acceptance checklist in M10 calls for it." Since M10 is exactly
that checklist, and the bullet is a contract-level acceptance criterion,
writing a checklist that admitted this as an open gap without closing it
would have been dishonest about what "acceptance" means. Closed it instead:

- **`webhookRegistered` on the Telegram settings view**
  (`src/dashboard/types.ts`, `src/control-api/snapshot.ts`, `app.ts`):
  whether `POST /api/v1/telegram/webhook` is actually registered right now
  (computed from `config.telegramWebhookSecret`/`telegramChatId`/
  `telegramUserId` all being set), shown distinctly from
  `configurationReady` (which only reflects the dashboard-editable
  `telegram_settings` row). These two can genuinely disagree -- they are
  separate stores, one env-driven at server startup, one DB-driven and
  owner-editable -- and previously nothing surfaced that gap to the owner.
- **`decidedBy`/`decidedAt` on the Approvals registry page**: sourced from
  `approval_requests.decided_by`/`decided_at` (already durably recorded by
  `PostgresApprovalRepository.decide()`, just never selected by
  `loadApprovals()` or rendered). For a Telegram-originated decision,
  `decidedBy` is the authorized Telegram user id -- this is the concrete
  "decision... observable from the dashboard" the acceptance bullet asks
  for.

Verified live: `tests/control-api.integration.test.ts`'s existing Telegram
webhook test (create approval -> decide via webhook) now additionally
asserts the decided approval appears in `/api/v1/dashboard/snapshot` with
the correct `decidedBy`/`decidedAt`, and that `webhookRegistered` is `true`
on a server configured with Telegram env vars and `false` on one without.

## Honest status on the two items not fully closed

- **Acceptance bullet 1** (DeepSeek -> Codex -> Claude routing with a real
  provider-credentialed click-through): verified at the automated-test and
  live-routing level, not with real provider API calls, since that requires
  real spend and the M9 staging instance deliberately does not run the
  background task-execution supervisor (a separate decision, per M9
  evidence). Documented as "Partially verified" with a named owner decision
  attached, not marked "Verified."
- **Acceptance bullet 6** (`npm run format:check` zero warnings
  repository-wide): confirmed still failing on 38 files as of this
  milestone (pre-existing from CONTRACT-001 through CONTRACT-012, nothing
  new introduced by CONTRACT-013's own work). This is exactly M11's job,
  explicitly placed last per the owner's own instruction -- documented as
  "Pending M11," not silently claimed done.

## Test evidence

2 new assertions added to an existing test (no new `test()` count change).
Full suite:

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 164
# pass 164
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run typecheck`, and
`scripts/verify-contract.ts CONTRACT-013` all pass. Redeployed to the M9
staging instance and re-verified live (`webhookRegistered: false` correctly
shown, matching staging's unconfigured Telegram state).
