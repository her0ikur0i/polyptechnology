# M7 — Session management (rename/archive/search) and folder view

Status: done, 2026-08-09. Scope confirmed earlier: rename, archive, and
search for v1; pin and branch/export explicitly deferred.

## What "folder/collection view grouped by project" concretely means here

Projects were already the natural "folder" unit (M1: `startConversation()`
bootstraps a project the moment a conversation begins, `idea`-state
projects included). What was missing was a way to move _between_ folders
from the conversation workspace itself -- the "Start a conversation" screen
could only ever bootstrap a brand-new project, with no way to pick an
existing one and resume within it. Added a project picker (backed by
`snapshot.projects.data`, already fetched by the dashboard shell, no new
endpoint needed) to the start screen, and a "resume" action on each history
item that switches the active conversation without leaving the page. That
is the folder/collection experience: pick a folder (project), see its
conversations, act on any of them.

## What was built

- `migrations/0013_conversation_session_management.sql`: one nullable
  `archived_at` column on `conversations` -- archiving is reversible
  (unarchive clears it back to `NULL`), not a soft-delete with no way
  back, since a UI that could only archive one-way with no undo would be a
  real dead end for the owner.
- `ConversationStore.renameConversation()`,
  `.setConversationArchived()`, and `.listConversations()` extended with
  `{ search, includeArchived }` -- implemented in both
  `PostgresConversationStore` (real `ILIKE` search, real filtering) and the
  test-only `MemoryConversationStore` (kept in sync, same interface).
- `OwnerCommandService.renameConversation()`/`.setConversationArchived()`
  and three routes: `POST /api/v1/orchestrator/conversations/:id/rename`,
  `POST /api/v1/orchestrator/conversations/:id/archive` (one route for
  both archive/unarchive via a body flag, not two near-duplicate routes),
  and `GET /api/v1/orchestrator/projects/:projectId/conversations` extended
  with `?search=`/`?includeArchived=` query params.
- UI: search box and "show archived" toggle on the conversation list,
  inline rename (click "Rename", edit, save/cancel), archive/unarchive
  toggle per item, and a project picker on the start screen.

## Verified live, not just by tests

Booted the real dev server and ran the exact sequence: renamed a real
conversation and confirmed the new title persists; archived it and
confirmed it disappears from the default list but reappears with
`includeArchived=true`; unarchived it and confirmed it returns to the
default list; searched for a matching substring and a non-matching one and
confirmed both filter correctly.

## Test evidence

1 new test in `tests/control-api.integration.test.ts` covering the full
rename -> stale-version-rejection -> archive -> default-list-exclusion ->
includeArchived-inclusion -> unarchive -> search-match ->
search-no-match -> missing-CSRF path in one flow, matching the live
verification above exactly.

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 177
# pass 177
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run dashboard:build`,
`npm run typecheck`, `npm run format:check`, and
`scripts/verify-contract.ts CONTRACT-014` all pass.
