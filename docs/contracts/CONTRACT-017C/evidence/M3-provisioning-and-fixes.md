# M3 — Provisioning works, and seven defects are closed

Date: 2026-08-11. Status: **done**.

## The result

```
generation drill: drill-3
reached: provisioning

  ok    provisioning
          runtime: node
          repoPath: /var/lib/polyp-ai-factory/project-workspaces/93231dee-…/repo
          projectState: provisioned
```

**`provisioned` is a state nothing in this system had ever written.** There is a
real git repository on disk with a real initial commit, and it passes all three
of the gates its future patches will be judged by:

```
typecheck OK   format:check OK   test OK
```

Verified against the actual staging workspace, not a fixture.

## What was fixed

Seven defects. Four were predicted in M1, one was found by M2, and two were
found only by running the thing.

### 1. Runtime treated as free text (found by M2)

`BlueprintTranslationDriver` passed the model's `runtime` string through
untouched into `NodeWorkspaceProvisioner`, which compares against exactly
`"node"`. The first real blueprint said `"node-22"` and could not be
provisioned.

`normalizeRuntime()` in `src/factory/blueprint.ts` now converts at the boundary
that owns the vocabulary: case, punctuation and trailing version digits are
stripped, then matched against an explicit alias table. `node-22`, `Node.js`,
`typescript` and `js` all map to `node`; `python3`, `go` and `rust` map to
nothing and are refused **at translation**, with the supported list in the
message, rather than silently minutes later at provisioning.

The provisioner's strict check is deliberately kept. Loosening it is what would
let a Python blueprint be scaffolded as Node.

An existing test asserted `document.stack.runtime === "node-22"` — it was
faithfully documenting the defect. Updated, with a comment saying so.

### 2. Every generation retry died before reaching a provider (M1 #2)

The gateway idempotency key lived in the immutable task spec, so all six
permitted attempts presented the same key while the request hash includes the
route. Same route → `attempt already exists`; escalated route →
`idempotency intent mismatch`.

`AiPatchOperationDriver` now derives a per-attempt key from
`OperationContext.attemptOrdinal`, exactly as `ConversationReplyDriver` has
since CONTRACT-017A M3. Attempt 1 keeps the original key so nothing already in
the ledger is orphaned.

**The escalation chain this system is built around had never once been able to
run on a generation task.** `maxAttempts: 6` was decorative.

### 3. A rejected patch stayed applied to the real repository (M1 #5)

`PatchApplier` gained `revert()`; `GitPatchApplier` implements it as
`git reset --hard` plus `git clean -fd` — deliberately without `-x`, so the
ignored `node_modules` survives, which matters because the verification sandbox
is network-free and cannot reinstall.

Without this, fixing #2 would have made things **worse**: attempt 2 would have
patched on top of attempt 1's rejected work, `git apply` would have failed on
context, and a recoverable rejection would have become a stuck task that looked
like a broken escalation chain.

### 4. No terminal state for a generated project (M1 #1)

The lifecycle defined `idea → blueprint → provisioned → development → …` and
**nothing in the codebase ever wrote the last two**. A flawless generation left
the project at `blueprint` forever.

`FactoryLifecycleAdvancer` (`src/factory/generation-lifecycle.ts`) advances a
project on the two occasions the pipeline actually completes something:
`provisioned` when a workspace exists on disk, `development` when a patch is
accepted. It is idempotent in both directions — already at the target is a
no-op, already past it is a no-op — so a replayed task cannot throw and a
project promoted to `demo` cannot be dragged backwards.

Wired at the two places that own those moments: the `/generate` route, and a
`PatchAcceptedHook` injected into `AiPatchOperationDriver`. Injected rather than
imported, because that driver is the generic patch executor and a patch task
that is not a generation supplies no hook.

### 5 and 6. Workspace permissions, as deployed (M1 #3, #4)

`/var/lib/polyp-ai-factory/project-workspaces` was `root:root 755` while the
Control API runs as `polyp-factory`. Now `polyp-factory:polyp-factory 750`.

`polyp-factory`'s home is a root-owned directory it cannot write, so `npm
install` would have failed on its own cache — a failure that reads as a network
or registry problem and is neither. The provisioner now pins `HOME` and
`npm_config_cache` inside the workspaces root, which makes provisioning
independent of how the service user's home happens to be configured. Code
rather than host state, so a redeploy cannot lose it.

### 7. The scaffold could not pass its own gates (M1, ranked Medium)

This one is the reason the milestone was worth doing.

The first real provisioning produced a workspace whose own `typecheck` failed:

```
error TS18003: No inputs were found in config file 'tsconfig.json'.
Specified 'include' paths were ["**/*"] and 'exclude' paths were [].
```

The scaffold contained **no TypeScript at all** — one `.js` placeholder test —
while `tsconfig.json` named neither `include` nor `exclude`.

And underneath that, worse: the test script globbed `tests/*.test.js` in a
project meant to be TypeScript, so it matched nothing. **`node --test` exits 0
when it matches no files.** Verification would have reported a pass having run
zero tests — a green gate that checks nothing, which is the same defect shape as
Factory Live's fixture-fed suite and CONTRACT-017A's silently-degrading session.

The scaffold is now coherent: `src/index.ts`, `tests/scaffold.test.ts` covering
it, `include`/`exclude` stated explicitly, `allowImportingTsExtensions` so the
form that actually runs under Node's type stripping is also the form that
typechecks, and `node --test 'tests/*.test.ts'` quoted so Node expands the glob
rather than the shell.

`format:check` was failing too, on `tsconfig.json`: `JSON.stringify(…, 2)`
expands every array and prettier collapses short ones. Rather than hand-matching
prettier's output, provisioning now **runs the project's own prettier** over the
scaffold before the initial commit. That is correct by construction and stays
correct when the scaffold is edited.

`tests/scaffold-gates.integration.test.ts` locks all of it in by provisioning a
real workspace and running the real chain.

**It caught its own false pass immediately.** The nested `node --test` detected
the outer test runner through `NODE_TEST_CONTEXT`, skipped, and exited 0 — the
exact failure the test exists to catch, reproduced inside the test itself. It
now strips that variable and asserts on `# pass 1` and `# fail 0` rather than on
the exit code alone.

### Also corrected: the memory ledger disagreed with the database

`MemoryAttemptLedger` still rejected a repeated `providerRequestId`. Migration
`0017` dropped exactly that constraint, because CONTRACT-017A established that
`provider_request_id` is a session id. A test ledger stricter than production
fails valid retries and would have made the #2 fix look broken.

## Test suite

**383 tests, 383 passing, 0 skipped**, up from 371 at CONTRACT-017A's close:

| Added                            | Count |
| -------------------------------- | ----- |
| `blueprint-runtime`              | +4    |
| `generation-retry`               | +5    |
| `ai-patch-driver` (revert paths) | +2    |
| `scaffold-gates.integration`     | +1    |

The standing invocation gains `TEST_SCAFFOLD_GATES=enabled`, on the same
reasoning as `TEST_WORKER_IMAGE`: the scaffold test runs a real `npm install`,
so ordinary runs should not pay for it — but a count reported without it is a
count with a gap.

## The disposable test database had to be recreated

Nine tests failed for a reason that was not a code defect: **`runOne()` is
global**, and the test database had accumulated 48 stray queued tasks — 41 of
them long before this session. `runOne()` takes the first 20 by task id, so
whether a test's own task is reachable depends on what else is queued. My M2
smoke run added one more and tipped it.

Recreated from `migrations/*.sql`, per the standing rule that this database is
disposable and recreated rather than deleted from. Worth recording because the
failure looked like a regression and was not, and it will recur.

## Deployment

Two releases, both restarted and verified active:
`20260811T072159Z-contract017c-fixes`, then
`20260811T073924Z-contract017c-scaffold`.

## Spend

**Zero.** Every fix in this milestone was verified without a provider call —
drill-3's translation reused the same conversation-session path as drill-2 and
the provisioning stage calls no model. The generation call is M4's.

## Scoring M1

| M1 said                                      | Outcome                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| #1 no terminal state — confirmed by grep     | Correct, fixed                                                                                    |
| #2 retries impossible — confirmed by reading | Correct, fixed                                                                                    |
| #3/#4 permissions — verified on host         | Correct, fixed                                                                                    |
| #5 rejected patch stays applied              | Correct, fixed                                                                                    |
| Scaffold may fail its own gates — **Medium** | **Correct, and understated.** It failed two of three, and one failure was a silent zero-test pass |
| Runtime mismatch — **Low**                   | Wrong tier; hit on run one (scored at M2)                                                         |

Both mis-ranked predictions were ranked _too low_, and both concerned the
boundary between components rather than the components themselves — which is
where this codebase's real defects have consistently been.

Still ahead, unchanged: whether a model can produce a git-applicable diff blind
(ranked High), and whether `prettier --check` rejects correct-but-differently
formatted output (ranked High). Both are M4's.
