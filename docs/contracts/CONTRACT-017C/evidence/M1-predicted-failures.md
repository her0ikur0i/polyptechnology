# M1 — Where the pipeline is predicted to break

Date: 2026-08-11. Status: **done**.

Written **before the drill runs**, deliberately. A prediction made in advance is
evidence about the system; one made afterwards is a story about its author. M6
will score this file honestly, including the misses.

Method: read the whole path — `POST /api/v1/orchestrator/proposals` →
approve → translate → `BlueprintTranslationDriver` →
`POST /api/v1/factory/projects/:id/generate` → `NodeWorkspaceProvisioner` →
`createGenerationTask` → `ExecutableTaskSupervisor` → `AiPatchOperationDriver`
→ `AiPatchExecutorDriver` → `AiGateway` → `git apply` → `executeWorker` —
plus the host and the staging database. No stage was run.

## Confirmed by reading or by the host, not predicted

These are not guesses. Each was verified without executing the pipeline.

### 1. A project can never get past `blueprint`. There is no success state.

`src/factory/lifecycle.ts` defines
`idea → blueprint → provisioned → development → demo → …`. Two call sites ever
transition a project, and **both go to `blueprint`**:
`owner-commands.ts:98` and `blueprint-translation-driver.ts:194`.

```
grep -rn '"provisioned"\|"development"\|"demo"' src/ --include=*.ts
  → only src/config.ts, matching NODE_ENV. Nothing else in the codebase.
```

**Nothing ever transitions a project to `provisioned` or `development`.** The
`/generate` route provisions a real workspace and creates a real task, and
never touches project state. So even a perfect end-to-end generation leaves the
project sitting at `blueprint`.

This matters more than a missing field: **the pipeline has no definition of
done for a project.** The contract's own gate — "a generated project in a
terminal successful state" — cannot be met by any amount of fixing further
down. It has to be built.

### 2. Every generation retry fails before reaching a provider

`createGenerationTask` stores `idempotencyKey: generate-<projectId>-1` in
`operation_task_specs.input`, which is immutable by trigger. `task.attemptCount`
is 0 at submit, so the `+ 1` is always 1 — the key is fixed for the life of the
task, across all 6 permitted attempts.

`AiGateway.execute()` hashes `{taskClass, attribution, messages,
maxOutputTokens, maxCostUsdMicros, policyVersion, route}` — **route included** —
and `PostgresAttemptLedger.reserve()` looks up by idempotency key:

- **Same route on retry** → same hash → row found, hash matches →
  `created: false` → `GatewayInvocationError("attempt already exists")`.
- **Different route on escalation** → different hash → row found, hash differs →
  `Error("idempotency intent mismatch")`.

Which one happens is decided by whether a routing policy is active.
**There are no rows in `orchestration_policies` on staging**, so
`PostgresPolicyRouteResolver.resolve()` returns the caller's fallback every
time and the route never changes. **Prediction: `attempt already exists`.**

Either way, **attempt 1 is the only attempt that can ever call a provider**, and
`maxAttempts: 6` — commented "enough to walk deepseek(x2) → codex(x2) →
claude" — is decorative. The escalation chain that is this project's central
routing principle has never been able to run on a generation task.

This is the same defect CONTRACT-017A closed at M3, **fixed only in
`ConversationReplyDriver`**. `AiPatchOperationDriver` never received the
per-attempt key, and 017A's contract scoped it to conversation replies. The fix
shape is known and proven; it needs applying here.

### 3. Workspace provisioning fails with EACCES, as deployed

```
/var/lib/polyp-ai-factory/project-workspaces   root:root 755   (empty)
polyp-control-api.service                      User=polyp-factory (uid 999)
```

Verified on the host: `sudo -u polyp-factory test -w …` → **not writable**.
`provision()` calls `mkdir(<root>/<projectId>/repo, {recursive:true})` from the
Control API process, so `/generate` fails before any model is involved.

### 4. `npm install` during provisioning fails for the same reason

`getent passwd polyp-factory` → home is `/var/lib/polyp-ai-factory`, itself
`root:root 755`, shell `nologin`. `provision()` shells out to
`npm install --no-audit --no-fund`, which needs a writable `HOME` for its cache
and config. Even with #3 fixed, this fails until the service user owns a home
it can write.

Both are deployment defects rather than code defects — which is exactly the
class of thing that only a real run finds, and the class CONTRACT-017's
`evidence/execution-enabled.md` already recorded four of.

### 5. A rejected patch stays applied to the real repository

`PatchApplier`'s documented contract (`ai-patch-driver.ts:23-32`) says
implementations "must never touch the real repository directly —
`workspaceRoot` is expected to already be an isolated worktree/copy". But
`createGenerationTask` passes `workspaceRoot: repoPath`, **the provisioned
project repo itself**. The flow is: apply to the real repo → copy to a temp dir
→ verify the copy.

So when verification rejects a patch, the repo keeps it. Nothing reverts. If
retries are ever fixed (#2), attempt 2 applies a second model's diff on top of
the first model's rejected work, and `git apply` will likely fail on context
mismatch — turning a fixable rejection into a stuck task.

Worth stating plainly: **fixing #2 without fixing #5 makes things worse**, not
better. They ship together.

## Genuine predictions — ranked by confidence

### High — the model must produce a git-applicable diff blind

The generation prompt asks for "a single unified diff (git apply-compatible)
against the existing repository" and describes the scaffold in prose. The model
never sees the actual file contents. `ownedPaths` is `"unscoped"`, so
`validatePatchScope` will not save it. Expect `git apply` failures on context
lines and paths, especially for edits to existing files rather than pure
additions.

**If this is what fails, the fix is not a better prompt** — it is giving the
executor the file contents it is patching.

### High — `prettier --check .` rejects model-written code

Verification is `typecheck && format:check && test` inside a `--read-only`
sandbox, so formatting can only be checked, never fixed. Model output that is
correct but formatted differently is rejected exactly like a failing test. This
is deliberate (`verification-image-policy.ts` argues for it) and is still the
likeliest single cause of a rejected-but-correct patch.

### Medium — the scaffold itself may not pass its own gates

`provision()` writes `package.json`, `tsconfig.json`, `README.md`,
`tests/scaffold.test.js`, `.gitignore`, then `npm install`. Nobody has ever run
`typecheck && format:check && test` against that scaffold. If the scaffold fails
its own verification, **every** patch is rejected regardless of quality, and the
cause will look like a model failure.

Cheap to settle before the drill: provision one workspace by hand and run the
chain. Doing that in M3.

### Medium — the verification temp directory crosses a process and user boundary

`createGenerationTask` calls `mkdtemp()` in the **Control API** process
(`polyp-factory`) and stores the path in the task spec. The **supervisor**
(`polyp-sequence.service`, `User=root`) later copies into it and mounts it.
Root writing into a `polyp-factory` temp dir works; the reverse would not, and
a `systemd` `PrivateTmp=` on either unit would make the path meaningless in the
other process. Checked: neither unit sets it today. Flagged because it is
invisible until it breaks.

### Low — blueprint translation produces an unusable runtime

`BlueprintTranslationDriver` builds the document itself with safe defaults and
takes only `slug`, `displayName`, `runtime`, `framework`, `database` and
`requirements` from the model. Only `runtime` can break provisioning, and it
defaults to `"node"`. Robust by construction; listed for completeness.

### Low — Docker image and worker isolation

The pinned image `node@sha256:d649c27d…` (node:22-bookworm-slim) **is present
on the host**. `polyp-sequence.service` runs as root, so the Docker socket is
reachable. `GitIgnoringWorkspaceCopier` already handles the two traps here —
`.git` exclusion and `verbatimSymlinks` for `node_modules/.bin` — both learned
the hard way in earlier contracts. Expect this stage to work.

## What this changes about the plan

M2–M5 were written as "drive each stage and see". Two of the four confirmed
findings are prerequisites rather than discoveries:

- **#1 (no success state) is design work**, not debugging. The lifecycle needs
  `blueprint → provisioned` at successful provisioning and
  `provisioned → development` at successful generation, with real evidence
  hashes. This lands in M5, where publication is.
- **#3 and #4 (permissions) block everything**, so they move to the front of
  M3 rather than being discovered there.

The milestone list stands otherwise. Nothing here needs an authority M0 did not
grant.

## Honest statement of what is not predicted

The cost. Attempt 1 is the only attempt that will reach a provider, so a failed
generation costs one `bulk_code` call — but the number of _drill iterations_
needed is genuinely unknown, and that is the money. Spend is reported at M6 per
the standing rule, and if a single scope approaches its $2.00 generation cap the
drill stops and reports rather than raising it.
