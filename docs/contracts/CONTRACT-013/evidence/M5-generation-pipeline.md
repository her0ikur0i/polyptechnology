# M5 — Factory-to-executor task creation wiring

Status: done, 2026-08-09. This milestone found and fixed five real,
previously-latent bugs -- every one of them only surfaced by actually
running the full pipeline for real (real Postgres, real Docker, real git),
not by unit tests with fakes.

## What changed

- **`src/operations/policy-route-resolver.ts`** (`PostgresPolicyRouteResolver`):
  bridges `AiGateway` (which only ever read the static
  `src/gateway/model-policy.ts` table) to the owner-adjustable `RuntimePolicy`
  engine built in CONTRACT-011/012 -- **these were fully disconnected systems
  until now**. The owner could draft/approve/activate a policy through the
  M4 dashboard and it would affect nothing real. For the three programming
  task classes the policy engine covers, the resolver now calls
  `simulateProgrammingRoute()` against whatever policy is active for
  `PROGRAMMING_POLICY_KEY` ("programming-routes",
  `src/policy/types.ts`), falling back to the static default when no policy
  is active, nothing is eligible, or the policy store errors. Wired into
  `sequence-main.ts` and the dashboard's default policy key
  (`policy-control.tsx`).
- **Escalation-loop bug, found by the resolver's own test**: without
  excluding already-attempted `provider:model` pairs from the availability
  set passed to `simulateProgrammingRoute()`, a still-live DeepSeek model
  (always permitted, per `execution-permission.ts`) would be re-selected
  forever instead of ever escalating past its own verified failure. Fixed by
  excluding every `provider:model` pair already present in
  `provider_artifacts` for the task (`src/operations/provider-artifact-store.ts`
  extended to return `requestedModelId`, not just `providerId`).
- **`src/factory/workspace-provisioner.ts`** (`NodeWorkspaceProvisioner`):
  resolves a project's logical `workspace://projects/{id}` reference
  (`src/factory/blueprint.ts`) to a real, git-initialized, `npm install`-ed
  directory. This never existed before -- "generated project" was pure
  database metadata with no filesystem/git counterpart at all. Only Node/TS
  scaffolds are supported, matching the single verification image policy
  owner decision.
- **`src/factory/generation-task.ts`** (`createGenerationTask`): the actual
  producer M2's `AiPatchExecutorDriver` always needed and never had --
  creates real `tasks`/`operation_task_specs` rows (driver=`ai_patch_executor`)
  and an `ai_budget_accounts` row from a real blueprint, so
  `ExecutableTaskSupervisor` can lease and run it.
- **`POST /api/v1/factory/projects/:id/generate`**
  (`src/control-api/app.ts`) + `generateProject()` client function + a
  "Start code generation" button in `factory-control.tsx`: the async trigger
  that provisions the workspace and queues the task. Deliberately does not
  execute inline -- the heavy work (AI call, Docker verification) happens
  later when the `sequence-main.ts` supervisor picks up the queued task, the
  same pattern already established for every other managed task.
- **`ownedPaths: "unscoped"`** (`src/operations/patch-scope.ts`,
  `ai-patch-driver.ts`, `ai-patch-operation-driver.ts`): a freshly-scaffolded
  generated project has no file-ownership manifest to check patches against
  (unlike a control-plane contract) -- an explicit, narrow opt-in that skips
  only the manifest-membership check, not the traversal/`.git` safety checks.
  The bare `"**"` string stays deliberately non-matching, unchanged from
  CONTRACT-011.

## Five real bugs found and fixed (in the order they were hit)

1. **`AiGateway`'s route-override validation used
   `JSON.stringify(a) === JSON.stringify(b)`.** Postgres jsonb does not
   preserve object key insertion order on storage -- a route round-tripped
   through `operation_task_specs.input` (jsonb) came back key-reordered and
   failed the string comparison every time, even though it was the identical
   route. Fixed with field-by-field comparison (`routeEquals()` in
   `src/gateway/gateway.ts`) -- small, fixed shape, no reason to rely on
   string equality for it in the first place.
2. **No `ai_budget_accounts` row for a freshly-created generation contract.**
   `AiGateway`'s reservation is scoped to `attribution.contractId`; without a
   budget row, every attempt failed closed with "budget unavailable" before
   any provider was ever called. `createGenerationTask()` now inserts one.
3. **`NodeWorkspaceProvisioner` never ran `npm install`.** The isolated
   verification sandbox is network-free by default
   (`src/worker/planner.ts`) -- `typecheck`/`format:check` need `tsc`/
   `prettier` binaries to already exist in `node_modules`, which requires one
   real, host-side, networked install per project before any task can reach
   the sandbox. Missing entirely; added.
4. **`fs.cp()`'s default `verbatimSymlinks: false` rewrites relative
   symlinks to absolute paths pointing back at the _original_ source.**
   `node_modules/.bin/tsc` is a relative symlink
   (`../typescript/bin/tsc`); copying it into the verification workspace
   (`GitIgnoringWorkspaceCopier`) without `verbatimSymlinks: true` silently
   produced a symlink pointing back into the git-apply workspace instead of
   resolving inside the copy -- `tsc: not found` inside the sandbox, which
   has no access to that other path. This is a genuinely obscure Node.js
   default; caught only by actually running the copy through real Docker
   verification, not by the unit tests written for M2 (which never exercised
   a real `node_modules` tree). New regression test:
   `tests/workspace-copy.test.ts`.
5. **Placeholder `ownedPaths: ["report.json"]`** in the verify job didn't
   correspond to any file the verify chain actually produces --
   `collectArtifacts()` requires every declared path to exist post-success,
   so a successful run still threw `ENOENT` before reaching the accept path.
   Changed to `["package.json"]`, which always exists.

## Test evidence

`tests/policy-route-resolver.test.ts` (7 tests, fakes, includes the
escalation-loop regression), `tests/workspace-copy.test.ts` (2 tests,
includes the symlink regression),
`tests/generation-pipeline.integration.test.ts` (1 test: real Postgres,
real Docker, real git -- blueprint -> provisioned workspace -> queued task ->
`ExecutableTaskSupervisor.runOne()` -> accepted patch actually present on
disk), `tests/control-api.integration.test.ts` (+1 test: the `/generate`
route, CSRF-gated, provisions and queues for real).

Full suite against a freshly recreated disposable database (migrations
0001-0010, zero carried-over state):

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 150
# pass 150
# fail 0
# skipped 0
```

`npm run dashboard:test` (18/18), `npm run dashboard:build` both pass.
`scripts/verify-contract.ts CONTRACT-013` passes.

## Note on shared disposable-database test isolation

`ExecutableTaskSupervisor.runOne()`'s eligible-task query has no per-test or
per-contract scoping -- any `queued` task left behind by one test is fair
game for the next test's supervisor run, anywhere in the suite. The
`control-api.integration.test.ts` "generate" test creates a real queued task
without running a supervisor against it; it now explicitly transitions that
task to `cancelled` afterward rather than leaving it as a landmine (this
was caught by a real CONTRACT-010-owned test failing when the full suite ran
together, not by either test in isolation).
