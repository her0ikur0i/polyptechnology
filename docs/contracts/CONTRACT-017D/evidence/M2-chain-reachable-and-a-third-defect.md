# M2 — the whole chain is reachable within a task's attempt budget

Date: 2026-08-12. Status: **done.**

Gate: _a run that exhausts its earlier tiers reaches `claude-sonnet-5`._ Met —
and getting a trustworthy run to prove it exposed a third real defect, on top
of the two M0 already knew about.

## The budget ceiling M1 didn't touch

M1 fixed attempts that never settle. It did not fix a narrower problem
sitting right next to it: `createGenerationTask()`
(`src/factory/generation-task.ts`) gave a task `maxAttempts: 6` — "enough to
walk deepseek(x2) -> codex(x2) -> claude" — but capped the task's own budget
scope at `2_000_000` micros ($2.00) while each attempt reserves `500_000`
micros ($0.50). `2_000_000 / 500_000 = 4`. **Only four attempts were ever
fundable, no matter what `maxAttempts` said.** A run whose first four tiers
are legitimately rejected — exactly what M0's `moneybag` brief produced —
could never reserve budget for a fifth attempt, so `claude-sonnet-5`, the
tier most likely to succeed on hard work, was structurally unreachable. This
is the same shape of bug M1 fixed (a limit nobody had sized against the
chain it was supposed to fund), in a different mechanism.

Fixed: the scope cap is now `3_000_000` micros ($3.00), the minimum that
funds all six attempts `maxAttempts` permits. Both the `factory_contracts`
row and the `ai_budget_accounts` row move together, named as
`CONTRACT_MAX_COST_USD_MICROS` rather than left as duplicated literals.

## The first drill run under the new cap reached tier five — on evidence that wasn't real

Reran the `moneybag` deep brief. The chain walked all five tiers for the
first time ever, including `claude-sonnet-5`:

```
deepseek:deepseek-v4-flash=rejected -> deepseek:deepseek-v4-pro=rejected ->
codex:gpt-5.6-terra=rejected -> codex:gpt-5.6-sol=rejected ->
claude:claude-sonnet-5=rejected
```

The budget ceiling was gone. But all four DeepSeek/Codex rejections carried
the identical reason:

```
verification_failed: > moneybag-18367348@0.0.0 typecheck
> tsc --noEmit

sh: 1: tsc: not found
```

Four different model attempts, one identical shell error. That is not four
models failing the same way — it is the same environment defect rejecting
every patch before any of them were actually judged.

## The third defect: `NODE_ENV=production` silently deletes every devDependency

`NodeWorkspaceProvisioner.provision()` (`src/factory/workspace-provisioner.ts`)
runs `npm install` on the host with `env: { ...process.env, ... }`.
`polyp-sequence.service` — the real, always-on production supervisor that
provisions every real generated project, not just drill runs — sets
`NODE_ENV=production` (`deploy/systemd/polyp-sequence.service` /
`sequence.env`), and that value flows straight into the child. `npm install`
reads it as "skip devDependencies." Every dependency the scaffold has --
`typescript`, `prettier`, `@types/node` -- **is** a devDependency, since none
of them ship in a generated project's own runtime. Under `NODE_ENV=production`
`npm install` installs none of them, leaving `node_modules` holding only an
empty `@types` stub and a `.package-lock.json` that claims otherwise.

Confirmed directly, not inferred: the actual staging repo from the corrupted
run had `node_modules/@types` and nothing else, while its own
`package-lock.json` listed all four packages as resolved. Reproduced in
isolation four ways before the mechanism was found — a bare `npm install`,
the same call through `execFile` exactly as the provisioner makes it, and the
real `NodeWorkspaceProvisioner` class directly — **all three succeeded**,
which is what made this genuinely hard to find: node_modules can't be
missing packages this way. It was only visible once the ambient environment
the real drill had inherited (`source sequence.env`, which sets
`NODE_ENV=production`) was also present in the repro. Setting only that one
variable reproduced it on the first try; deleting it fixed it on the first
try.

**This is not a drill artifact. `polyp-sequence.service` has run with
`NODE_ENV=production` since it was written**, so every project the live
supervisor has ever auto-provisioned was exposed to this — silently, since
the resulting rejection reads exactly like a real one in
`provider_artifacts.reason` and nothing else distinguishes it.

Fixed in `workspace-provisioner.ts`: the `npm install` call now sets
`npm_config_include: "dev"`, which forces devDependencies in regardless of
`NODE_ENV`. Regression test added —
`tests/scaffold-gates.integration.test.ts`, "provisioning under
NODE_ENV=production still installs devDependencies" — that sets
`process.env.NODE_ENV = "production"` around a real `provision()` call and
asserts `npm run typecheck` succeeds afterward. Both scaffold-gates tests
pass under `TEST_SCAFFOLD_GATES=enabled`.

**Why the standing test suite never caught this:** the zero-skip invocation
in `CLAUDE.md` does not set `NODE_ENV=production`, so nothing in the suite
ran under the one condition that triggers the bug. The new test sets it
explicitly rather than relying on the ambient environment, so it exercises
the failure mode instead of the ambient accident of whichever shell runs it.

## The second run: a real, trustworthy result

Same brief, same budget cap, provisioning fixed. The chain now produced real
verdicts:

| Tier                         | Verdict      | Why                                                        |
| ---------------------------- | ------------ | ---------------------------------------------------------- |
| `deepseek:deepseek-v4-flash` | rejected     | `patch has no diff --git headers` — a real malformed patch |
| `codex:gpt-5.6-terra`        | rejected     | its own tests: 9 tests, 8 pass, **1 fail**                 |
| `codex:gpt-5.6-sol`          | **accepted** | verified by `isolated-worker-v1`, 316 changed lines        |

Verified in the sandbox, committed (`36c3434 "Generated by codex:gpt-5.6-sol"`
on top of the scaffold), and confirmed by hand afterward: `node_modules/.bin/tsc`
present in the published repo, `src/index.ts` and `tests/moneybag.test.ts`
both real files. **This is the first time the `moneybag` brief has produced
an accepted, verified, published result** — on the second escalation tier,
without ever needing `claude-sonnet-5`, exactly the "no attempt wasted" state
M1's evidence anticipated. Total real spend across both of today's runs:
**$0.023**, against $3.00 caps that were never close to binding once tsc
existed.

## What M2 answers from the open question in `docs/RESUME.md`

"Does the chain need to reach `claude-sonnet-5` at all?" — on this brief, no:
`gpt-5.6-sol` (technical-fallback-retry) produced an accepted patch. That is
a fact about this one brief, not a general claim; the chain reaching
`claude-sonnet-5` in the _first_ (corrupted) run proves the mechanism works
when a run needs it to, which is the actual gate.

## Left for later, not this milestone

A $0.50 reservation from the first (corrupted) run's `claude-sonnet-5`
rejection did not release — the scope `de063fe0-4a55-4deb-aa92-6dfa84ca237d`
shows $0.0084 spent against $0.50 still reserved. Adds to the pile M5
already owns (`scripts/reconcile-provider-attempt.ts` with a real evidence
SHA); not investigated further here since M5 is the milestone that owns
reconciliation, and this is one more row of the same kind, not a new
mechanism.
