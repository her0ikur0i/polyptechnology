# M3 — Safe Markdown and Code Rendering

Date: 2026-08-13. Status: **done**.

M3 adds rendered assistant message content without trusting model output as HTML.
The dashboard now parses a deliberately narrow markdown subset into React nodes:
paragraphs, inline code, safe links, fenced code blocks, lightweight token
highlighting, and per-block copy controls.

## Implementation

- `src/dashboard/message-renderer.tsx` renders markdown as React text nodes and
  never uses `dangerouslySetInnerHTML`.
- Link creation is allow-listed to `http:`, `https:`, and `mailto:`. Unsafe
  targets such as `javascript:` render as inert text instead of anchors.
- Fenced code blocks render in `<pre><code>` with token spans for comments,
  strings, and common TypeScript/JavaScript keywords.
- Copy controls report success only after `navigator.clipboard.writeText()`
  resolves, and report failure without throwing when clipboard access is
  unavailable or denied.
- `src/dashboard/conversation-workspace.tsx` uses the renderer for persisted
  messages and streamed assistant progress.
- `vite.config.ts` now runs dashboard test files serially with a modest timeout,
  because the suite mutates browser-wide globals (`history`, `fetch`,
  `matchMedia`) and full-suite parallelism caused route/axe tests to race even
  when every file passed alone.

## Security review

Independent read-only review found three issues before close:

- The client had an SSE resume route but fell back to polling after a stream
  error instead of reconnecting with the last ordinal.
- The SSE route had no stream lifetime/cap and did not handle backpressure.
- Code-block copy claimed success even when clipboard writes failed.

All three were fixed before this evidence was accepted:

- `ConversationWorkspacePage` now retries `EventSource` streams with the last
  received ordinal, accepts server retry cursors, bounds reconnect attempts, and
  clears delayed reconnect timers on unmount or conversation switch.
- The Control API reply stream now caps concurrent readers per task, emits a
  retry cursor at a bounded lifetime, and waits for response `drain` or `close`
  when writes hit backpressure.
- Clipboard writes now show `Copied` only on success and `Copy failed` on
  rejection/unavailability.

Follow-up review then found two cleanup gaps:

- Starting or resuming a conversation did not cancel an already scheduled
  stream reconnect timer.
- Backpressure waits could outlive the configured stream lifetime.

Both were fixed before commit: conversation resets now close the active
`EventSource` and clear reconnect timers, and `writeSse()` bounds `drain`
waiting by the same stream deadline used by the route.

## Validation

- `npm run format:check` — passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.
- `npx vitest run tests/dashboard/api.test.ts tests/dashboard/message-renderer.test.tsx tests/dashboard/app.test.tsx`
  — passed, 3 files / 16 tests.
- With `polyp-sequence.service` stopped to avoid racing queued reply tasks:
  `TEST_DATABASE_URL=... node --import tsx --test tests/control-api.integration.test.ts`
  — passed, 24 tests, 0 skips.
- `npm run dashboard:test` — passed, 6 files / 43 tests.
- `npm run dashboard:build` — passed.
- With `polyp-sequence.service` stopped to avoid production-worker races:
  `TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... TEST_SCAFFOLD_GATES=enabled npm test`
  — passed, 435 tests, 435 pass, 0 skips.
- `npm audit` — passed, 0 vulnerabilities.

The live `polyp-sequence.service` was restarted after the database-backed
integration test and verified active.
