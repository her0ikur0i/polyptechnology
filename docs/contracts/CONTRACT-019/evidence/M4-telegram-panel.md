# CONTRACT-019 M4 Evidence — Telegram Settings and Test Panel

## Status

M4 is complete.

## Implementation

Changed files:

- `src/control-api/app.ts`
- `src/dashboard/api.ts`
- `src/dashboard/app.tsx`
- `src/dashboard/styles.css`
- `src/dashboard/types.ts`
- `src/dashboard/validation.ts`
- `tests/control-api.integration.test.ts`
- `tests/dashboard/api.test.ts`
- `tests/dashboard/app.test.tsx`
- `tests/dashboard/validation.test.ts`

Backend:

- Added `POST /api/v1/settings/telegram/test`.
- Route is owner-gated and CSRF-gated.
- Supported test kinds:
  - `connectivity`: calls Telegram `getMe`.
  - `test_message`: sends one bounded test report to the configured chat.
- Uses only server-side `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Returns a structured result:
  - `state`
  - `checkedAt`
  - `summary`
- Test message is rendered through `renderReport()`, uses `parse_mode=HTML`,
  and is checked under Telegram's 4000-character safe ceiling.
- Added an injectable `telegramFetch` dependency for tests so no real Telegram
  network call is made in the test suite.

Frontend:

- Direct Telegram page from the M3 `/telegram` route now includes:
  - secret reference input;
  - authorized chat/user ID inputs;
  - configuration readiness;
  - webhook route readiness;
  - paid probe/approval status;
  - Check connection button;
  - Send test message button;
  - visible report quietness rules.
- Test commands use same-origin credentials and the dashboard CSRF token.
- Browser validation accepts only the structured test result shape.

Report rules shown in the page:

- terminal events only; no internal success spam;
- human title, subject and summary first;
- model/tokens/cost/budget/fallback only when useful;
- bounded, escaped, text-only operational reports;
- human labels before UUIDs whenever one exists.

## Validation

Commands run:

- `npm run dashboard:test`
  - initial parallel run: one 10s timeout while the heavier control API
    integration test was running concurrently;
  - isolated rerun: 6 files passed, 52 tests passed.
- `npm run typecheck`
  - passed.
- `npm run format:check`
  - passed.
- `TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 TEST_SCAFFOLD_GATES=enabled node --import tsx --test tests/control-api.integration.test.ts`
  - passed with escalation for local socket/database permissions;
  - 26 tests passed.

The server-side Telegram test specifically verifies that the generated
`sendMessage` body is owner-gated, bounded, uses HTML parse mode, and escapes
`<`, `>`, and `&`.

## Residual Scope

M4 does not persist last test result in the database and does not expose poller
heartbeat history. The current snapshot still reports live probe state from
stored configuration and process config. A richer last-report/last-update history
belongs with M7 runs/evidence or M10 polish if the backing data is added there.

## Next Step

Proceed to M5: conversation goal-clarification mode.
