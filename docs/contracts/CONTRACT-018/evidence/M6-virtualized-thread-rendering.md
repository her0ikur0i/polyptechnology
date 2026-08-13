# M6 — Virtualized Thread Rendering

Date: 2026-08-13. Status: **done**.

M6 keeps long dashboard conversations responsive by mounting only the active
message window once a thread grows beyond 80 stored turns. The full transcript
remains in React state and in the backend; virtualization trims only the DOM.

## Implementation

- `src/dashboard/conversation-workspace.tsx` now computes a bounded visible
  window for long threads, with top and bottom spacers preserving scroll range.
- Short conversations keep the previous direct `messages.map()` behavior.
- The newest turns stay visible on initial load and after returning to a stored
  conversation.
- Bottom-stick behavior is conditional: if the owner has scrolled up to read
  older context, new message state does not force the thread back to the bottom.
- Message identity and full-state logic are preserved: send versioning and
  Regenerate still use the complete `messages` array, not the mounted row set.

## Review Notes

A read-only reviewer called out the main failure modes before close:

- never replace canonical `messages` with visible rows;
- keep streaming and pending reply controls mounted at the bottom;
- avoid hijacking manual scroll position;
- prove bounded DOM count rather than only proving that the page renders.

The implementation and tests cover the first, third, and fourth points
directly. The existing M2/M4 streaming and stop/regenerate tests remain active
and now run with the same component after virtualization was added.

## Validation

- `npx vitest run tests/dashboard/app.test.tsx` — passed, 13 tests.
- `npm run dashboard:test` — passed, 6 files / 49 tests.
- `npm run typecheck` — passed.
- `npm run dashboard:build` — passed.
- `npm run build` — passed.
- `npm run format:check` — passed.
- `git diff --check` — passed.
- `TEST_DATABASE_URL=... TEST_SCAFFOLD_GATES=enabled npm test` — passed,
  440 tests, 440 pass, 0 skips.
- `npm audit` — passed, 0 vulnerabilities.
- `polyp-sequence.service` — restarted after database-backed tests and verified
  active.

The long-thread regression test seeds 200 messages, asserts the newest turn is
visible, asserts the oldest turn is unmounted, asserts fewer than 40 bubbles are
mounted, and asserts Regenerate posts the last owner turn with
`expectedVersion: 200`.
