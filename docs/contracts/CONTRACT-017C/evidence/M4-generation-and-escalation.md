# M4 — DeepSeek and Codex run the pipeline, and four more defects fall

Date: 2026-08-11. Status: **done.** Generation runs, patches apply, and the
isolated worker executes them — which is this milestone's subject. Getting a
patch to _pass_ verification is M5's.

All three registered providers now reach the pipeline. That was the owner's
explicit requirement for this milestone: "make sure the patch solve the
communication problem between 3 provider registered."

## The question that started it

The owner asked whether DeepSeek and Codex can be operated to finish the work.
For this milestone that is not a choice — it is the design. `bulk_code` routes:

```
deepseek-v4-flash -> deepseek-v4-pro -> codex gpt-5.6-terra -> codex gpt-5.6-sol -> claude-sonnet-5
```

DeepSeek is the mandatory first executor; Codex is the technical-fallback tier.
Probed both before starting: DeepSeek answered a canary for **$0.000005**, and
`codex login status` reports authenticated.

## What now works that never has

**The escalation chain walks.** Real evidence from staging:

```
tiers: deepseek:deepseek-v4-flash=rejected
    -> deepseek:deepseek-v4-pro=rejected
    -> codex:gpt-5.6-terra=rejected
```

Three providers, three tiers, one task. Before this contract, a generation task
could make exactly one attempt.

**A patch was applied and verified.** `deepseek-v4-flash | verification_failed`
means the diff applied to the real repository and ran the full
`typecheck && format:check && test` chain inside the Docker sandbox. Every
earlier attempt died at `git apply`.

## The four defects fixed here

### 1. Codex had never worked, at all

Every Codex attempt failed on startup:

```
codex_cli_exit_1: Not inside a trusted directory and
                  --skip-git-repo-check was not specified.
```

The supervisor runs from the release directory, which is not a git repository
Codex trusts. **The technical-fallback tier was configured, routed to, and had
never once produced a completion.** Fixed by passing `--skip-git-repo-check`.

Safe because of what the adapter is: Codex is used as a plain completion
provider, prompt in and text out. The sandbox and approval flow that the git
check protects belong to the agentic path, which nothing here uses — the
returned diff is applied by `GitPatchApplier` and verified in the worker under
exactly the same scrutiny as any other provider's.

### 2. A patch that would not apply left no evidence

`git apply` throwing propagated straight out of the driver, so the attempt
failed with **no `provider_artifacts` row written**. That row is the evidence
`deriveFailureEvidence()` reads to unlock the next tier — so the most common
failure a code executor has was precisely the one that could never justify an
escalation. Six real attempts produced six apply failures and zero artifacts.

Now recorded as `patch_apply_failed: <git's own message>` and returned as a
rejection rather than a crash.

### 3. The static escalation chain was unreachable past tier one

`PostgresPolicyRouteResolver` returned the caller's fallback whenever no owner
policy was active — which is the normal state; `orchestration_policies` has
never had a row. The fallback is the _first_ entry of the static table, so
every attempt ran `deepseek-v4-flash`.

**The chain that this project's contracts, comments and roadmap all describe as
its central routing principle existed only on paper.** It now walks the table,
skipping tiers this task has already tried, read from `provider_artifacts` —
the same durable evidence the policy path uses, so a transport failure that
recorded nothing retries its own tier rather than being skipped.

Two existing tests asserted the old behaviour and were documenting the defect;
updated, with two more added for escalation and exhaustion.

### 4. The executor was asked to patch files it had never seen

M1 ranked this High and it was the dominant failure. The prompt described the
scaffold in prose. The model guessed `package.json`'s contents, invented a
`test/` directory when the repository has `tests/`, and produced diffs git
called corrupt.

`createGenerationTask` now reads the scaffold and includes the **full contents**
of the files a patch might touch, and the system prompt states the rules that
actually matter: exact paths, prefer new files (a `/dev/null` hunk cannot
conflict), correct hunk headers, no prose or fences, no new dependencies.

## The finding worth the whole milestone: `git apply --recount`

Even with real file contents, diffs kept failing as `corrupt patch at line N`.
A direct probe of DeepSeek showed why — the diff **body** is correct and the
**hunk header count** is wrong:

```
@@ -0,0 +1,9 @@     <- claims nine lines
+export function slugify(input: string): string {
... seven lines of body ...
```

Verified against a real captured failure:

| Invocation                              | Result                     |
| --------------------------------------- | -------------------------- |
| `git apply --check`                     | corrupt at line 14         |
| `git apply --check --recount`           | **applies**                |
| `git apply --check --recount --numstat` | **applies**, stats correct |

`--recount` derives the counts from the hunk body instead of trusting the
header. It weakens nothing that matters: context lines must still match the
file exactly, `validatePatchScope` still runs before it and the full
verification chain after it. What it removes is a purely clerical failure that
was rejecting correct work.

This is what let a patch reach verification for the first time.

## The communication problem between the three providers

Fixed after the owner named it directly. The three registered providers do not
speak identically, and the pipeline only understood one of them.

### A. `deepseek-v4-pro` was rejected for how it wrapped its answer

Every attempt failed with `patch has no diff --git headers`. It is a thinking
model — 2,458 reasoning tokens against 492 of output — and it explains itself
and fences the diff. That is a correct answer presented conversationally, and
**a whole tier of the escalation chain was unusable because of presentation
rather than substance.**

`extractUnifiedDiff()` now finds the diff in whatever the provider answered
with: a fenced block if one contains a diff, otherwise from the first
`diff --git` header onward. Deliberately narrow — it locates a diff, it never
repairs one, and a response containing no diff still fails exactly as loudly as
before. The _same_ extracted string is both scope-validated and applied, so
nothing can be smuggled between the two.

This is the same defect shape as the blueprint runtime arriving as `node-22`: a
boundary demanding one exact form, fed by a model with no way to know which
form was meant. Both fixes belong at the boundary, not in a prompt that hopes.

### B. Failed attempts never released their budget reservation

**$6.70 held against $1.84 actually spent.** Three generation scopes each hold
$1.50 of a $2.00 cap while having spent $0.003:

| Attempt outcome   | Count |
| ----------------- | ----- |
| `succeeded`       | 38    |
| `outcome_unknown` | 15    |
| `dispatched`      | 5     |

Twenty attempts never settled, and each holds its `maxCostUsdMicros` ceiling.
That is why attempt 6 died with `gateway budget unavailable or exhausted`:
**three failed attempts are enough to exhaust a scope regardless of what was
spent**, which caps the escalation chain at roughly three tiers no matter what
`maxAttempts` says.

This is the same defect the resume checkpoint has recorded since CONTRACT-008
as "$0.60 reserved but never released", now visible at ten times the size
because this milestone finally generated enough failures to see it.

**Fixed for the case that caused it.** A CLI adapter failing with _empty
stdout_ produced no telemetry at all — it refused to start, mis-parsed its
arguments, or died before reporting — so no provider request was ever made and
nothing could have been charged. That was being flagged `outcomeUnknown: true`,
which instructs the ledger to hold the reservation permanently against a charge
that cannot exist. It is now `false`.

The discriminator is structural rather than a string match: no stdout means no
provider response was ever parsed, so there is nothing to reconcile. Partial
output is still treated as unknown, because there a response may genuinely have
been produced and billed.

Attempts already stranded in `outcome_unknown` and `dispatched` still hold
their reservations; releasing those needs `scripts/reconcile-provider-attempt.ts`
and a real evidence SHA, which is deliberately not invented. It does not block
progress: each generation task gets a fresh contract scope and a fresh cap.

### The result, after all three fixes

```
drill-8 tiers:
  deepseek:deepseek-v4-flash = rejected   (31 lines applied, reached verification)
  deepseek:deepseek-v4-pro   = rejected   (produced a real diff; corrupt hunk)
  codex:gpt-5.6-terra        = rejected   (produced a real diff; corrupt hunk)
  codex:gpt-5.6-sol          = rejected   (produced a real diff; corrupt hunk)
```

**Four tiers, three providers, four recorded artifacts, no budget starvation.**
Every registered provider now reaches the pipeline, produces a patch, and is
judged on that patch. Before this contract the chain could not leave tier one,
Codex had never produced a completion, and `deepseek-v4-pro` was rejected
unread.

What remains is quality, not communication: `deepseek-v4-flash` gets a patch
applied and fails the verification gates, and the other tiers still emit hunks
git will not take even with `--recount`.

### C. Verification failure records no detail

`verification_failed` is stored with no captured output, so nothing says
whether the model wrote bad code or the gate itself is broken. The sandbox's
stdout is discarded. For a system whose whole argument is that evidence beats
assertion, that is a gap.

## Suite and spend

**385 tests, 385 passing, 0 skipped** under the standing invocation.

Spend for this milestone: **$1.84 across all scopes**, plus $6.70 wrongly held
(see B). Reported rather than tallied silently.

## Scoring M1 again

| M1 said                                                   | Outcome                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Model must produce a git-applicable diff blind — **High** | **Correct, and the dominant failure.** Fixed by giving it the files _and_ `--recount` |
| `prettier --check` rejects correct output — **High**      | Not yet reached; one patch got to verification and failed for an unknown reason (C)   |

M1 said of the diff problem: "the fix is not a better prompt — it is giving the
executor the file contents it is patching." That was right, and incomplete: the
file contents were necessary and `--recount` was the other half.

## Security review, and what it caught

Run before the push, per the standing rule. **One High finding, in my own
change, and it was right.**

Enabling Codex meant passing `--skip-git-repo-check`. I justified that on the
grounds that "Codex is used as a plain completion provider, prompt in and text
out" — and nothing in the invocation made that true. `codex exec` is Codex's
_agentic_ entrypoint. The trust check I removed was the only thing standing
between an untrusted model and `/opt/polyp-ai-factory/current` — the deployed
release tree, confirmed as the supervisor's `WorkingDirectory` — as its working
root, with whatever write and command permissions the CLI defaults to there.

The comment asserted a boundary that no flag enforced. That is precisely the
class of defect this contract exists to find, and I wrote it.

**Replaced rather than removed.** Every Codex call now states its boundary:

| Flag                    | Why                                                       |
| ----------------------- | --------------------------------------------------------- |
| `--cd <fresh temp dir>` | A working root created for that one call, holding nothing |
| `--sandbox read-only`   | No writes, no command execution, whatever the prompt says |
| `--skip-git-repo-check` | Now safe, because the two above define what it may reach  |

There is deliberately no `--ask-for-approval`: `codex exec` does not accept one,
being the non-interactive entrypoint, so the sandbox is the control rather than
a prompt nobody could answer. Verified live afterwards — Codex still returns a
completion under these flags.

The reviewer cleared the other six areas explicitly, including the one that
mattered most: `extractUnifiedDiff()` produces a single string that is both
scope-validated and applied, so nothing can be smuggled between validation and
application, and `--recount` cannot attach a hunk to a path the scope check
never saw.
