# M4 — Chat UI, replacing FactoryControlPage

Status: done, 2026-08-09.

## What replaced what

`src/dashboard/factory-control.tsx` (two bare forms: "Reviewed contract
proposal" and "Generate isolated project blueprint," plus a "Start code
generation" button) is deleted entirely -- per the confirmed decision,
chat replaces the manual blueprint form, not an additional parallel path.
`/orchestrator` now renders `ConversationWorkspacePage`
(`src/dashboard/conversation-workspace.tsx`), a real message thread with a
composer, file upload, and a "past conversations" panel, wired to M1-M3's
routes.

The old page's client functions in `src/dashboard/api.ts`
(`createFactoryProject`, `createConversationProposal`) are **not** deleted
in this milestone even though nothing currently calls them -- `generateProject`
is confirmed still needed for M6 (starting real generation once a blueprint
exists), and whether `createFactoryProject`/`createConversationProposal`
are reused or superseded depends on decisions M5/M6 haven't been made yet.
Deleting them now would be guessing; M11's cleanup pass is where genuinely
orphaned exports get resolved with full certainty, not mid-build.

## Replies are polled, not blocking, matching M2's queued-task design

Sending a message immediately shows the owner's own message, then polls
`GET /api/v1/orchestrator/reply-tasks/:taskId` every 1.5s (up to ~90s) for
a terminal state, showing a "Thinking…" bubble in the meantime. This
directly reflects M2's real architecture -- the reply is a queued
background task, not a synchronous call -- rather than the UI pretending
it's instant. If the poll budget runs out, the owner sees an explicit
"still waiting, refresh in a moment" message instead of a silently stuck
spinner.

## A real jsdom test gap found and fixed

jsdom does not implement `Element.prototype.scrollIntoView` -- the
auto-scroll-to-latest-message effect crashed every dashboard test that
rendered this page, not just a new one, since the polyfill needed to live
in the shared test setup. Added a one-line stub to
`tests/dashboard/setup.ts` (guarded, only applied if missing) rather than
removing the auto-scroll behavior to work around the test environment.

## Verified live, not just by tests

Booted the real dev server against the disposable test database (built
via `npm run build && npm run dashboard:build`, the actual compiled
artifacts, not `tsx` source) and ran the exact call sequence the UI
performs: start a conversation with no project, confirm the SPA `index.html`
and dashboard bundle serve correctly, send a message, confirm the queued
reply task is reachable and `"queued"` (no supervisor running against this
disposable database), and confirm the new conversation appears in the
project's conversation history -- the same live-process rigor CONTRACT-012's
M4 evidence established after the Express 5 wildcard-route bug was only
caught by curling a real running server, not by tests alone.

## Test evidence

Updated `tests/dashboard/app.test.tsx`'s CSRF-boundary test (previously
targeted the deleted blueprint form) to start a conversation instead,
asserting the composer renders and `POST /api/v1/orchestrator/conversations`
was called with the CSRF header. `npm run dashboard:test`: 19/19 (same
count as before -- one test replaced, not added, matching the 1:1
page swap).

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 170
# pass 170
# fail 0
# skipped 0
```

`npm run dashboard:build`, `npm run typecheck`, `npm run format:check`, and
`scripts/verify-contract.ts CONTRACT-014` all pass.
