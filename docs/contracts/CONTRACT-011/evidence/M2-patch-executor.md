# M2 — DeepSeek patch executor and artifact provenance

Status: done and wired into the live supervisor loop, 2026-08-09.

## What changed (core, first pass)

- `src/operations/patch-scope.ts`: parses a unified diff's `diff --git`
  headers, rejects unparseable patches, validates every touched path against
  a contract's owned-paths manifest (same safety posture as
  `src/work/git-publication.ts`, kept independent on purpose). 6 tests.
- `src/policy/derive-failure-evidence.ts`: turns `provider_artifacts` rows
  into the `FailureEvidence[]` shape `execution-permission.ts` /
  `simulate-route.ts` consume -- this is the missing producer the original
  version of this evidence file flagged. Only `deepseek`/`codex` rejections
  become evidence; `claude` rejections produce none (nothing left to fall
  back to). 5 tests.
- `src/operations/provider-artifact-store.ts`: Postgres read/write for
  `provider_artifacts`, re-asserting the same accepted/rejected field
  invariant the migration's CHECK constraint already encodes.
- `src/operations/ai-patch-driver.ts` (`AiPatchExecutorDriver`): routes one
  attempt through `AiGateway`, validates patch scope, applies it via an
  injected `PatchApplier`, runs verification through the existing hardened
  Docker sandbox (`src/worker/executor.ts`, unmodified), records the
  accept/reject verdict, classifies the outcome via `classifyAttempt()`. An
  out-of-scope patch is rejected _before_ the verification sandbox runs. 3
  tests with fake adapters/runners.
- `src/operations/git-patch-applier.ts` (`GitPatchApplier`): real
  `git apply --check --numstat` then `git apply`, tested against a real
  temporary git repository (not mocked), including a patch that fails to
  apply cleanly leaving the workspace provably untouched. 3 tests.

## What changed (wiring, second pass)

- **Architecture finding:** `ExecutableTaskSupervisor` (built in CONTRACT-010)
  assumed every driver's correct output hash is known _before_ execution
  (`operation_task_specs.expected_output_sha256`, compared byte-for-byte
  after the driver runs). That fits a deterministic driver; it cannot fit an
  AI-generated patch, whose correctness is only knowable _after_ an isolated
  verifier runs. Fixed with a minimal, backward-compatible extension rather
  than replacing the component:
  - `migrations/0009_ai_patch_executor.sql`: `expected_output_sha256` is now
    nullable; a new CHECK pair enforces it stays mandatory for
    `deterministic_sha256` (CONTRACT-010's original invariant, unchanged) and
    stays NULL for the new `ai_patch_executor` driver.
  - `src/operations/execution-supervisor.ts`: when
    `expectedOutputSha256 === null`, success is decided by the driver's own
    returned `{ verified: boolean }` (`isSelfVerifyingResult`, exported and
    unit-tested) instead of a hash comparison. `DeterministicSha256Driver`'s
    behavior and all of CONTRACT-010's existing tests are untouched --
    verified by re-running `tests/operations.test.ts` and
    `tests/operations-postgres.integration.test.ts` after the change (both
    still 100% pass).
- `src/operations/ai-patch-operation-driver.ts` (`AiPatchOperationDriver`):
  adapts `AiPatchExecutorDriver` to the `OperationDriver` interface the
  supervisor drives, including `parseStoredAiPatchTaskInput` -- the jsonb
  storage boundary (a `WorkerJob.capabilities` `Set` and an `AbortSignal`
  cannot round-trip through jsonb, so the stored shape differs slightly and
  is validated, failing closed on anything malformed). 5 parser tests.
- `src/operations/verification-image-policy.ts`: owner decision 2026-08-09 --
  a single pinned Node image
  (`node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`,
  `node:22-bookworm-slim`) running `npm test`, until a real per-stack
  registry is needed. Verification deliberately does not run `npm ci` --
  the isolated workspace copy already carries `node_modules` from the source
  checkout, so it stays network-free (`WorkerJob` defaults to
  `--network=none`).
- `src/orchestrator/sequence-main.ts`: registers `ai_patch_executor` in the
  supervisor's driver map alongside the untouched `deterministic_sha256`,
  wired to a real `AiGateway` (all three provider adapters), real
  `GitPatchApplier`, real `SpawnWorkerRunner`, real
  `PostgresProviderArtifactStore`.
- `tests/ai-patch-executor-integration.test.ts`: proves the whole chain
  against a **real** disposable Postgres -- a self-verified accept flows a
  task to `succeeded`, a self-verified reject flows it to `failed`, and a
  `deterministic_sha256` spec with a NULL hash is rejected at the database
  level (constraint, not app code).

## What changed (third pass, 2026-08-09: verified with real Docker, not fakes)

The claims above were only proven against fake adapters/runners. Building a
real end-to-end test (`tests/ai-patch-driver-docker.integration.test.ts`,
real `git apply`, real Docker container) surfaced a genuine design bug:
`executeWorker()` deliberately refuses any workspace containing `.git`, but
the driver applied the patch via `git apply` into the _same_ directory it
then handed to that same sandbox. Fixed with
`src/operations/workspace-copy.ts` (`GitIgnoringWorkspaceCopier`): the
git-apply target and the verification sandbox are now always separate
directories, the latter populated by a `.git`-excluding copy the driver
performs itself (`AiPatchExecutorDriver` gained a `workspaceCopier`
constructor dependency). Confirmed with two real end-to-end tests -- a
passing patch is accepted, a patch that applies but fails real verification
is rejected and escalates.

**Code-cleanliness gate** (so executor output is never messy): `prettier`
added as a devDependency, `.prettierrc.json` pins `trailingComma: "all"`,
`npm run format`/`format:check` added.
`verificationCommandFor()`'s default command is now
`npm run typecheck && npm run format:check && npm test`, run inside the
sandbox via `sh -c`. The sandbox is `--read-only`, so this can only check and
reject, never auto-fix -- a rejection escalates exactly like a failing test.
Every generated project must carry matching `typecheck`/`format:check` npm
scripts; this repo's own `package.json` is the template.

**`docs/contracts/CONTRACT-011/contract.md`'s own file-ownership manifest was
itself out of scope** for a few paths this work legitimately touched
(`package.json`, `package-lock.json`, `.prettierrc.json`,
`migrations/0009_ai_patch_executor.sql`) -- caught by running
`scripts/verify-contract.ts` for real, not assumed. Fixed in the contract
text (Amendment 2).

## Test evidence

Full suite against the disposable CONTRACT-011 database (migrations
0001-0009 applied) **and** a real Docker daemon, zero skips:

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 npm test

# tests 128
# pass 128
# fail 0
# skipped 0
```

The previously-standing skip (`tests/docker-worker.integration.test.ts`) was
never a bug -- it's deliberately gated behind `TEST_WORKER_IMAGE` so ordinary
runs don't pay a Docker-pull cost by default. Supplying a real pinned digest
(resolved from the image already pulled for the disposable database) is the
standing zero-skip invocation from here forward.

## What is still missing

`src/factory/lifecycle.ts` still has zero references to `AiGateway` or
`model-policy` -- `ProjectLifecycle` only tracks project _state_
(idea -> blueprint -> ... -> production); nothing today creates the `tasks` /
`operation_task_specs` rows that would let a real blueprint actually lease
and run through `AiPatchExecutorDriver`. This is the remaining piece that
makes "generate project with the new model routing" possible end-to-end.
