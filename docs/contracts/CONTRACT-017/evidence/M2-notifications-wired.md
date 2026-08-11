# M2 — Notifications wired to real event sources

Date: 2026-08-10. Status: **done**.

## One hook, not several

`ExecutableTaskSupervisor.runOne()` gained a single notification point, placed
where every lease resolves through — after `executeLease()` returns, before the
next task is picked up. Both the success path and all four failure paths funnel
there.

The alternative was hooking the success return and the `fail()` helper
separately, which is how a notifier ends up faithfully reporting three of the
four ways work can end. One point is harder to get wrong and impossible to
partially wire.

## Reporting cannot break the work it reports on

This is the property the whole milestone is built around, and it is enforced in
three places rather than trusted once:

- **`taskFinished()` swallows everything.** A Telegram outage, a malformed chat
  id, a rate limit — none of them are reasons to fail a task that already
  succeeded, or to mask one that already failed. A notifier that can throw into
  the execution path converts "we could not tell you" into "the work broke",
  which is strictly worse than having no notifier.
- **The ledger read is separately guarded.** Being unable to price a failure is
  not a reason to stop reporting it, so a facts lookup that throws degrades to a
  report without numbers rather than to no report.
- **The notifier is an optional constructor argument.** With no Telegram
  credentials configured, the supervisor behaves exactly as it did before.

## Real numbers, from records that already existed

`PostgresRunFacts` reads what a task actually cost rather than estimating.
`ai_gateway_attempts.attribution` is `jsonb` carrying `taskId`, joined to
`ai_usage_events` for tokens and cost, then to `ai_budget_accounts` through the
attempt's `budget_scope_id` for the remaining budget.

Spend is summed **across every attempt the task made, including failed ones** —
which is precisely the number that matters when the report is about a failure.
A report that showed only the successful attempt's cost would understate exactly
the case the owner most needs to understand.

## Failure reasons phrased for a person, not for a schema

The work engine's reasons are `policy`, `verification`, `worker`,
`invalid_output`. Those are correct enum values and they mean nothing to someone
reading their phone. They render as "refused by routing policy", "verification
gate failed", "worker or transport failure", "provider returned unusable
output".

A reason this build has no phrasing for is passed through verbatim rather than
dropped: an unfamiliar word is still more useful than silence.

An unrecognised task _outcome_ falls back to ⚠️, never ✅. Defaulting an unknown
state to success is the one wrong answer available.

## Verification

`tests/run-notifier.test.ts` — 7 tests, each pinning a decision rather than a
shape:

- a succeeded task reports as success, `parse_mode: HTML`;
- a failed task reports "verification gate failed", not `verification`, and
  names the attempt number;
- an unrecognised reason is passed through rather than swallowed;
- an unknown outcome reports as ⚠️, never ✅;
- usage and budget appear when the ledger has them;
- **a ledger read failure costs the numbers, not the report**;
- **a Telegram outage never propagates** — the transport throws, and
  `taskFinished()` still resolves.

Full backend suite, standing zero-skip invocation:

```
# tests 240
# pass 240
# fail 0
# skipped 0
```

240 = 233 after M1 + 7 new. `typecheck` clean, `format:check` clean
repository-wide.

## Not yet true, and deliberately

`polyp-sequence.service` is still not running, so no real task has yet produced
one of these reports on staging. The wiring is verified by test, and the
transport itself was verified live in CONTRACT-016's probe; what has not
happened is the two meeting on a real costed run. That remains withheld until
execution is authorized, and this evidence does not claim otherwise.

Budget-threshold alerts and incident reports are also not wired — this milestone
covers task completion, which is the event the owner named first. The remaining
sources are carried by the contract's own scope, not quietly dropped.
