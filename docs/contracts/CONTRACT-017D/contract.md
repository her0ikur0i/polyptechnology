# CONTRACT-017D — The drill, reproducible and unattended

## Objective

A pipeline that has worked is not a pipeline that works.

CONTRACT-017C got the factory generating software end to end. Every success it
recorded came from one brief: a single pure function in a single file. The
first genuinely harder brief failed on every tier, which is the finding this
contract exists to act on.

## What the deep drill showed

`scripts/generation-drill.ts <label> deep` asks for `moneybag`: integer minor
units, a parser that must reject bad input, `add`/`subtract` that throw on
mismatched currency, an `allocate` that must not lose or invent a cent, and
`format`. Several exported functions, interacting rules, real error cases.

**It failed on both runs.** The escalation chain walked and every tier was
rejected — and, importantly, rejected for _legitimate_ reasons:

| Tier                  | Verdict  | Why                                           |
| --------------------- | -------- | --------------------------------------------- |
| `deepseek-v4-flash`   | rejected | `TS2578: Unused '@ts-expect-error' directive` |
| `deepseek-v4-pro`     | rejected | same, then an empty answer on a later attempt |
| `codex:gpt-5.6-terra` | rejected | its own tests: 17 tests, 13 pass, **4 fail**  |

**The gates work.** Every rejection was real code that genuinely did not
compile or genuinely failed its own tests. Nothing here is a false negative,
and that is worth as much as the successes: the verification chain that had
never seen a file in CONTRACT-017C is now demonstrably rejecting bad work.

What failed is the _factory's_ ability to get hard work right within its
attempt budget — which is a different problem from the plumbing 017C fixed.

## Scope

- **Reproducibility.** The drill runs from a genuinely clean database with
  nothing else queued, twice, and produces the same terminal result. This is
  the one thing 017C's PRD entry (R2.8) is marked Partial for.
- **Reaching the last tier.** 017C's escalation fix is in and tested, but the
  deep drill still exhausted `maxAttempts` before asking `claude-sonnet-5`,
  the tier most likely to succeed on hard work. Either the budget of attempts
  or the order has to change.
- **Codex attempts that never settle.** Three attempts in one deep run ended
  in `dispatched`: the ledger never recorded a verdict, which both leaks the
  reservation and denies the escalation chain its evidence.
- **Escalation visible to the owner.** A failure report names one model while
  the run walked four tiers. The data is in `provider_artifacts`; only the
  report is thin.
- **The stale reservations.** $11.70 held by attempts stranded before 017C's
  classification fix, released through
  `scripts/reconcile-provider-attempt.ts` with real evidence rather than an
  invented SHA.

## Out of scope

- Making models better at hard briefs. If `moneybag` still fails with the
  whole chain reachable and settling correctly, that is a finding about model
  capability at this task size, not a defect to fix here — and it belongs in a
  contract about task decomposition, not this one.
- Any dashboard work. CONTRACT-018 owns it.
- Multi-runtime generation. CONTRACT-021.

## Milestones

0. M0: owner confirmation — carried; the owner granted approval authority for
   this work on 2026-08-11 and asked that it not be re-sought.
1. M1: Codex attempts settle a verdict, always. No `dispatched` survivors.
2. M2: the whole chain is reachable within a task's attempt budget, proven by
   a run that reaches the final tier.
3. M3: reports show the tiers a run actually walked.
4. M4: the drill runs from a clean database, twice, with the same result.
5. M5: stale reservations reconciled with real evidence.
6. M6: README, security review, close.

## Gates

- A generation task never leaves an attempt in `dispatched`.
- A run that exhausts its earlier tiers reaches `claude-sonnet-5`.
- A failure report names every tier attempted, in order.
- Two clean-database runs produce the same terminal result.
- Full suite, dashboard suite, `typecheck`, `format:check`, `npm audit`,
  `verify-contract.ts CONTRACT-017D`, `resume-checkpoint.ts --check`, zero
  skips.
- `/security-review` clean, or findings fixed before the push.

## Acceptance

- The factory's failures are always explained by evidence it recorded itself.
- The owner can see which models were tried and in what order.
- A drill on a clean database is boring and repeatable.

## Rollback

Revert the commit. Everything here is additive to a pipeline that already
works on simple briefs.

## Amendment 1 — `deploy/**` (2026-08-11, M1)

M1's root cause was a systemd unit setting: `TasksMax=64` was one task short of
a single `codex exec`, so the cgroup ran out of task slots mid-attempt and the
next `fork(2)` killed the supervisor. `deploy/systemd/polyp-sequence.service`
is the repository's copy of that unit, and fixing the crash without it would
leave the fix on the host alone, to be undone by the next deployment.

`deploy/**` is therefore part of this contract's File ownership. Taken under
the authority the owner granted on 2026-08-11 rather than raised as a question,
since it is scope bookkeeping for work the contract already owns.

## Amendment 2 — provisioning's `NODE_ENV=production` defect (2026-08-12, M2)

M2's own gate ("a run that exhausts its earlier tiers reaches
`claude-sonnet-5`") could not be honestly claimed without also fixing what M2
found while proving it: `NodeWorkspaceProvisioner.provision()` silently
skipped every devDependency under `NODE_ENV=production` — the real production
supervisor's own environment — leaving every generated scaffold without
`tsc`. This is squarely inside "Reaching the last tier," not the "Out of
scope: making models better at hard briefs" exclusion — it is the same class
of finding as CONTRACT-017C's `/tmp` bug: the gate wasn't judging code, it was
failing before it saw any. `src/**` and `tests/**` already cover the files
this touched (`workspace-provisioner.ts`,
`scaffold-gates.integration.test.ts`); no new File ownership needed.

## File ownership

- `docs/contracts/CONTRACT-017D/**`
- `deploy/**`
- `docs/product/**`
- `docs/architecture/**`
- `docs/RESUME.md`
- `README.md`
- `CLAUDE.md`
- `migrations/**`
- `src/**`
- `scripts/**`
- `tests/**`
