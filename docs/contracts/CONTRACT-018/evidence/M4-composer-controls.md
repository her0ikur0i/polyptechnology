# M4 — Composer Controls

Date: 2026-08-13. Status: **done**.

M4 makes the conversation composer behave like a real daily chat surface:
autosizing input, Enter-to-send with Shift+Enter for newlines, optimistic owner
echo, Stop, Regenerate, edit-as-draft, and send-failure recovery that keeps the
typed draft recoverable.

## Implementation

- `src/dashboard/conversation-workspace.tsx` now autosizes the composer textarea
  up to a bounded height and submits on Enter unless Shift is held.
- Sending immediately appends a local owner bubble, replaces it with the stored
  message after the command succeeds, and restores the draft if the send fails.
- Sending and regenerating are blocked while an assistant reply is pending, so
  the client cannot create overlapping reply tasks by accident.
- Owner messages expose an Edit action that copies the message back into the
  composer without mutating the stored transcript.
- Regenerate resends the last owner message through the same audited
  `sendConversationMessage()` path.
- Stop calls a new owner-authenticated, CSRF-protected reply-task cancel route.
  The route is scoped to `operation_task_specs.driver='conversation_reply'`,
  cancels queued or active reply work, deletes live leases, and marks the active
  attempt cancelled.

## Security Review

Independent read-only review found three issues before close:

- Stop cleared UI state before `cancelReplyTask()` succeeded, so a network or
  auth failure could make the UI falsely look stopped while the backend task
  kept running.
- Send was allowed while a reply was still pending, which could create
  overlapping paid reply tasks and abandon the earlier client stream.
- Active-state cancellation lacked coverage for leases, attempt rows, and stale
  worker fences.

All three were fixed before this evidence was accepted:

- Stop now keeps the stream, task id, pending state, and Stop button active
  until the cancel command succeeds.
- Send and Regenerate now short-circuit while a reply is pending, and the Send
  button is disabled in that state.
- The database-backed Control API test now leases and runs a real
  `conversation_reply` task, cancels it through the public route, proves the
  lease is deleted, proves the current attempt is marked cancelled, and proves a
  stale worker fence cannot transition the task afterward.

## Validation

- `npm run typecheck` — passed.
- `npx vitest run tests/dashboard/api.test.ts tests/dashboard/app.test.tsx` —
  passed, 2 files / 16 tests.
- With `polyp-sequence.service` stopped to avoid production-worker races:
  `TEST_DATABASE_URL=... node --import tsx --test tests/control-api.integration.test.ts`
  — passed, 25 tests, 0 skips.
- `npm run format:check` — passed.
- `git diff --check` — passed.
- `npm run dashboard:build` — passed.
- `npm run dashboard:test` — passed, 6 files / 46 tests.
- `npm audit` — passed, 0 vulnerabilities.
- `node --import tsx scripts/verify-contract.ts CONTRACT-018` — passed.
- `node --import tsx scripts/resume-checkpoint.ts --check` — passed.
- With `polyp-sequence.service` stopped to avoid production-worker races:
  `TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... TEST_SCAFFOLD_GATES=enabled npm test`
  — passed, 436 tests, 436 pass, 0 skips.

The live `polyp-sequence.service` was restarted after database-backed test runs
and verified active.
