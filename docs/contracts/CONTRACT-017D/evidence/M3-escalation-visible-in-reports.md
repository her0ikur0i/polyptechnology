# M3 — reports show the tiers a run actually walked

Date: 2026-08-12. Status: **done.**

Gate: _a failure report names every tier attempted, in order._ Met.

## What was thin

`PostgresRunFacts.usageFor()` (`src/operations/run-notifier.ts`) picks the
single costliest attempt from `ai_gateway_attempts` — right for "what did
this cost", wrong for "what happened". `TelegramRunNotifier.taskFinished()`
built its report from that one row, so a run that walked five tiers reported
one model name. The data was never missing — `provider_artifacts` has held
every tier's verdict since CONTRACT-017C — the report just never read it.

M2's own drill made the gap concrete: a report for that run would have read
"❌ Task failed · verification gate failed" and named `claude-sonnet-5`
alone, when the run had in fact tried `deepseek-v4-flash`, `deepseek-v4-pro`,
`gpt-5.6-terra` and `gpt-5.6-sol` first — three real rejections, one of them
(now known) an infrastructure defect, none of it visible to the owner reading
their phone.

## Fixed

`PostgresRunFacts.tiersFor(taskId)` reads `provider_artifacts` in
`created_at` order and returns `{ provider, model, status }` for every row —
the same query `scripts/generation-drill.ts` already used to build its own
`tiers:` line, now shared rather than reimplemented a second time silently.

`taskFinished()` calls it whenever `this.facts` is set, and appends a detail
line — `deepseek-v4-flash→rejected, gpt-5.6-terra→rejected,
claude-sonnet-5→rejected` — whenever more than one tier is on record. A
single-tier run adds nothing: the existing usage line already names that one
model, and a redundant "tiers: X" would say nothing new.

Guarded with `try`/`catch`, not `.catch()` — a `facts` stub without
`tiersFor` (there are several across the test suite, all written before this
milestone) throws synchronously calling a method that does not exist, before
any promise exists for `.catch()` to attach to. `describe()` just above it
in the same function already carries this exact guard for the same reason;
`tiersFor()` now matches it rather than becoming the second place this bug
could reappear.

## Tests

`tests/run-notifier.test.ts`: a multi-tier failure names every tier in
order; a single-tier run stays silent about tiers; a `facts` stub missing
`tiersFor` costs the tier line, not the report (three new cases, all
passing). Full suite: **414 tests, 414 passing, 0 skipped** under the
standing zero-skip invocation, up from 411 at M2's close — +1
`scaffold-gates` (M2's `NODE_ENV=production` regression test) + 3
`run-notifier` (this milestone's).
