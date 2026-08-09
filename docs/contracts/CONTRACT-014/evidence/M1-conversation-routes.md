# M1 — Conversation & message routes, idea-state project bootstrap

Status: done, 2026-08-09.

## A real schema constraint found before writing any route code

`generated_projects.blueprint_id`/`blueprint_version_id` are both `NOT NULL`
with a foreign key into `project_blueprint_versions` (migration
`0006_factory_knowledge.sql`). Even though `'idea'` is a legal
`generated_projects.state` value and `docs/SYSTEM-SPECIFICATION.md` Section
17 describes an `idea -> blueprint -> ...` lifecycle, a project row
literally cannot exist in the database without an already-published,
fully-formed blueprint document first. "Start chatting before you know the
runtime/framework/database" is not schema-representable as a bare row with
no blueprint at all.

Chose the least invasive fix: reuse `publishBlueprint()`/`createProject()`
exactly as the existing `OwnerCommandService.createProject()` already does,
publishing an explicit placeholder `BlueprintDocument` (`slug:
untitled-<id>`, `displayName: "Untitled project"`, `stack` fields literally
`"unspecified"`, one placeholder requirement string) instead of loosening
the `NOT NULL`/FK constraint. This required zero migration and zero changes
to any code that already assumes `blueprintVersionId` is always present
(the `/generate` route, `createGenerationTask`, etc. -- all untouched).
Deliberately does **not** call `transition(..., to: "blueprint")` afterward,
unlike `createProject()` -- the placeholder isn't a real blueprint, so the
project honestly stays at `idea` state until M6 publishes a real one
derived from the conversation and re-points `blueprint_version_id`.

## What was built

- `ConversationStore.listConversations(projectId)` -- new interface method
  (`src/orchestrator/types.ts`), implemented in both
  `PostgresConversationStore` and the test-only `MemoryConversationStore`
  (kept in sync since both implement the same interface).
- `OwnerCommandService.startConversation()` -- reuses `context.actorId` +
  `idempotencyKey`-derived deterministic UUIDs (the same pattern
  `createProject`/`createProposal` already use) for the project, blueprint,
  version, and conversation IDs, so retries are safe replays, not
  duplicates. Bootstraps a project only when `projectId` is omitted;
  otherwise requires the referenced project to actually exist
  (`factory.getProject`).
- `OwnerCommandService.sendMessage()` -- validates bounds (content
  1-20,000 chars, matching the pattern of every other command validator in
  this file), computes `contentSha256` server-side, defaults
  `classification: "internal"` (documented in a code comment: never
  "public" for a private planning conversation, never "confidential"/
  "secret" without an explicit signal warranting it -- ADR-0002's
  classification is what later gates context eligibility, not a guess made
  here).
- Four new Control API routes (`src/control-api/app.ts`):
  `POST /api/v1/orchestrator/conversations` (CSRF-gated),
  `POST /api/v1/orchestrator/conversations/:id/messages` (CSRF-gated),
  `GET /api/v1/orchestrator/conversations/:id/messages` (read-only, no CSRF
  gate -- matches the `/api/v1/policy/simulate` precedent for queries),
  `GET /api/v1/orchestrator/projects/:projectId/conversations` (read-only).

## Verified live, not just by tests

Booted the real dev server against the disposable test database and
exercised all four routes with `curl` before writing any formal test:
bootstrapped a conversation with no `projectId` and confirmed a real
`idea`-state row appeared in `generated_projects` with a real published
placeholder blueprint attached; sent a message and read it back via the
list route; started a second conversation against the now-existing project
and confirmed both routes see two conversations; confirmed a missing CSRF
token is rejected with 403 on both mutating routes.

## Test evidence

4 new tests appended to `tests/control-api.integration.test.ts`: bootstrap
creates a real `idea`-state project (verified via the dashboard snapshot's
`lifecycle` field, not just the route's own response), message round-trip
including a stale-version rejection, conversation reuse on an existing
project, and CSRF rejection for both mutating routes (with an explicit
check that the read-only routes are _not_ CSRF-gated, documenting that
boundary rather than leaving it implicit).

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 168
# pass 168
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run dashboard:build`,
`npm run typecheck`, `npm run format:check`, and
`scripts/verify-contract.ts CONTRACT-014` all pass.
