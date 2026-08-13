# M2 — Progressive Reply Stream

Date: 2026-08-13. Status: **done**.

M2 required the dashboard client to consume reply progress and render it
progressively, including reconnect/resume behavior. While starting this work,
M1 was found incomplete: the durable chunk store existed, but the Control API
SSE route specified by the contract did not. M1 was repaired first, then the
client was wired to it.

## Implementation

- `src/control-api/app.ts` now serves
  `GET /api/v1/orchestrator/reply-tasks/:taskId/stream?after=N` as
  `text/event-stream`.
- `src/dashboard/api.ts` exposes `subscribeReplyStream()`, validates streamed
  `chunk` and `done` payloads through `src/dashboard/validation.ts`, and closes
  the `EventSource` on terminal completion.
- `src/dashboard/conversation-workspace.tsx` uses the stream first after a
  message send, appends incoming fragments into the pending assistant bubble,
  then refreshes authoritative persisted messages when the server emits
  `done`.
- The previous reply-status polling path remains as the fallback when
  `EventSource` is unavailable or the stream disconnects.

## Validation

- `npm run format:check` — passed.
- `npm run typecheck` — passed.
- `npx vitest run tests/dashboard/api.test.ts` — passed, 1 file / 3 tests.
- With `polyp-sequence.service` stopped to avoid racing the queued test task:
  `TEST_DATABASE_URL=... node --import tsx --test tests/control-api.integration.test.ts`
  — passed, 23 tests, 0 skips.
- `npm run dashboard:build` — passed.
- `npm test` — passed, 401 tests, 359 pass, 42 environment-gated skips.

The live `polyp-sequence.service` was restarted after the database-backed
integration test and verified active.
