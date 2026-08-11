# M3 — One budget calculation

Date: 2026-08-11. Status: **done**.

## Two surfaces, one scope, two answers

In the same batch of messages the owner received:

```
run report   📊 ░░░░░░░░░░  6% · $4.68 left of $5.00
/budget      █░░░░░░░░░ 18% · $0.3202 spent of $5.00
               $0.6000 reserved
```

Both about scope `92f89ba7`. The run report counted spend; `/budget` counted
spend plus reservations. Reservations are money that is committed and cannot be
spent again, so the run report overstated available budget by exactly the
amount most likely to be stuck — in this case $0.60 held by three
`outcome_unknown` attempts that nothing will release without a manual
reconciliation.

Truly spendable was **$4.08**, not $4.68.

## The fix

`budgetSummary()` in `src/telegram/report.ts` is now the only place this
arithmetic happens. It takes spent, reserved and the limit and returns the bar,
the percentage, what is committed and what is left. `renderReport()`, `/status`
and `/budget` all call it.

`PostgresRunFacts.usageFor()` now selects `reserved_usd_micros` — its absence
was half the bug — and `/status` passes the reservation through instead of
dropping it on the way to the report.

Reservations are named only when there are any. A "$0.00 reserved" on every
message is precisely the zero-valued noise this contract removes.

## The test that keeps them equal

`tests/report-consistency.test.ts` renders `/budget`, `/status` and a run
report from the _same_ account and asserts the extracted percentage and
remaining figure are identical strings. Two surfaces cannot drift apart again
without failing a test that names the original contradiction.

Separately: `budgetSummary` is asserted to compute $4.08 and 18% for exactly
the numbers the owner saw.
