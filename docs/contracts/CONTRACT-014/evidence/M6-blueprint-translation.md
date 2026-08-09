# M6 — Blueprint translation, feeding the existing generation pipeline

Status: done, 2026-08-09.

## Architecture: one more queued AiGateway call, same pattern as M2

Translation is a `blueprint_translation` task (new driver type, migration
`0012_blueprint_translation.sql`), queued and run by the same background
supervisor that already runs `conversation_reply` and `ai_patch_executor`
tasks -- not a synchronous call inside the HTTP request, for the same
reason M2 made that choice. `BlueprintTranslationDriver`
(`src/operations/blueprint-translation-driver.ts`) sends the approved
proposal's compiled transcript (M5) through `AiGateway` with
`taskClass: "orchestration"` (still Claude-first, still not the
DeepSeek -> Codex -> Claude programming chain -- this is structured
extraction from a conversation, not code generation) and a system prompt
asking for strict JSON matching the blueprint's core fields.

## Every extracted field still goes through `parseBlueprint()` unchanged

The model's JSON response is mapped into a full `BlueprintDocument` --
`slug`/`displayName`/`stack`/`requirements` from the model,
`qualityGates`/`capabilities`/`resources`/`lifecyclePolicy` filled with the
same server-side defaults `OwnerCommandService.createProject()` already
uses (never model-authored: resource limits and the production/destructive
-approval flags are not something a text-extraction step should be trusted
to set) -- then validated through the exact same `parseBlueprint()` the
existing, **unmodified** generation pipeline (`createGenerationTask`,
CONTRACT-013 M5) already requires. A successful translation is therefore
guaranteed to produce something the generation pipeline can actually
consume, not a shape this driver invented independently.

## A real gap found while building this: no way to re-point a project's blueprint

`PostgresProjectFactory.createProject()` only ever sets
`blueprint_id`/`blueprint_version_id` once, at creation. Every
conversation-bootstrapped project (M1) starts with a placeholder blueprint
attached that way -- there was no method to swap it for a real one
afterward. Added `attachBlueprintVersion()`: version-fenced like every
other mutation on `generated_projects`, re-confirms the target blueprint
version is actually published (not just any id), then the driver calls
`factory.transition(..., to: "blueprint")` to move the project out of
`idea` for real.

## Fails closed on a bad model response, not silently or by crashing

A non-JSON response, a non-object response, or a response that fails
`parseBlueprint()`'s validation all return `{ verified: false, reason }`
from the driver -- the task reaches a real retry/failure state through the
supervisor's existing outcome handling, and the project is left completely
untouched (still `idea`, no half-written blueprint). Proven with a
dedicated test using a fake adapter that returns a plain-English refusal
instead of JSON.

## What was built

- `migrations/0012_blueprint_translation.sql`.
- `BlueprintTranslationDriver` (`src/operations/blueprint-translation-driver.ts`).
- `queueBlueprintTranslation()` (`src/factory/blueprint-translation-task.ts`),
  mirroring `reply-task.ts`'s pattern, scoped per proposal.
- `PostgresProjectFactory.attachBlueprintVersion()` (`src/factory/postgres-repository.ts`).
- `POST /api/v1/orchestrator/proposals/:id/translate` -- gated on the
  proposal actually being `handed_off` (rejects a too-early attempt with a
  clear error, verified live).
- Reused the existing `GET /api/v1/orchestrator/reply-tasks/:taskId`
  status route (already driver-agnostic -- just reads `tasks.state`, no
  new route needed for polling).
- UI: a "Translate to blueprint" button appears once a proposal is
  `handed_off`, polls status the same way message replies do, and once
  succeeded shows a "Start code generation" button wired to the existing,
  unmodified `generateProject()` client function from CONTRACT-013 M5.

## Verified live, not just by tests

Booted the real dev server and confirmed the route-level gating with
`curl`: translating a nonexistent proposal id fails with `"proposal not
found"`; translating a real proposal before approval fails with `"only a
handed-off proposal can be translated into a blueprint"`; after approving,
translation queues a real task, and its status is reachable and `"queued"`
(no supervisor running against the disposable database, expected). The
actual extraction logic (model call -> JSON -> `parseBlueprint()` ->
`attachBlueprintVersion()` -> lifecycle transition) can't be exercised this
way without real provider credentials, so it's proven by a dedicated
integration test with a fake adapter instead (see below) -- the same split
CONTRACT-013 M5 and this contract's M2 already established between
"prove the route layer live" and "prove the driver logic with a real
supervisor and a real Postgres database, fake only at the provider
boundary."

This live pass queued real tasks against the shared disposable database
again -- recreated it fresh before running the formal suite, same as every
prior milestone that did live testing this contract.

## Test evidence

2 new tests in `tests/blueprint-translation.integration.test.ts`: the full
success path (draft -> approve -> translate -> real published blueprint
version -> project transitions to `blueprint`, with the extracted fields
verified against the actual stored document), and the fail-closed path (a
non-JSON model response leaves the project at `idea`, task does not reach
`succeeded`). 1 new test in `tests/control-api.integration.test.ts` for the
route-level gating and queueing.

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 176
# pass 176
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run dashboard:build`,
`npm run typecheck`, `npm run format:check`, and
`scripts/verify-contract.ts CONTRACT-014` all pass.
