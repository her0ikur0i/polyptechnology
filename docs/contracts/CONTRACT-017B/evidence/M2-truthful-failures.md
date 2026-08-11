# M2 — Failure reports that name what actually failed

Date: 2026-08-11. Status: **done**.

## The accusation that was not true

Every failure the owner saw said:

```
🔒 provider returned unusable output
🤖 claude-sonnet-5 · claude
🎟 0 in · 0 out
💰 $0.00
```

The provider had not been called. Zero tokens in, zero out, nothing charged,
and no `ai_gateway_attempts` row — the message contradicted itself three lines
later and still pointed the owner at Claude. The real cause was
`idempotency intent mismatch`, thrown inside this system before any request
left the host.

The mechanism: every throw from every driver lands in one `catch` and becomes
the enum `invalid_output`, which `REASON_TEXT` rendered as a specific,
checkable claim about a third party.

## Three changes

1. **The catch-all says what is actually known.** `invalid_output` now reads
   "the run failed before producing output" — true whatever threw.
2. **The real error travels with the event.** The supervisor already caught it
   and, since CONTRACT-017, logged it; it now also passes it through
   `TaskFinished.detail`, and the report prints it. That is the line that would
   have said `idempotency intent mismatch` on day one.
3. **Absence of a provider call is stated.** When a failure has no usage row,
   the report adds "No provider call was made, nothing was charged." The
   difference between "your provider misbehaved" and "we refused this before
   spending anything" is the difference between the owner investigating Claude
   and investigating us.

## Two robustness findings while wiring it

**A synchronous throw in the facts object silenced the whole report.** The
description lookup was written as `await this.facts.describe(id).catch(...)`.
If `describe` is missing or throws synchronously, the throw happens _before_
`.catch` is attached, lands in the outer handler, and the owner is told
nothing. Found because two existing tests pass a fake facts object with only
`usageFor`. It is now a `try`/`catch` around the call, falling back to the
driver-derived name: losing the label costs the label, not the message.

**The terminal-outcome filter was an allow-list, and that was wrong.** The
first implementation reported only `succeeded`, `failed`, `cancelled` — which
would silently swallow any state a later contract adds. An existing test
("an unknown outcome is reported as needing attention") caught it. It is now a
deny-list of exactly `retry_wait`: progress is silent, anything unrecognised
still reports as a warning. In a contract about not leaving the owner
uninformed, failing closed into silence was the wrong default.

## Tests

`tests/run-notifier.test.ts`, 12 passing, including:

- a failure with no provider attempt does not blame the provider, names the
  real error, and says nothing was charged
- a retry sends nothing at all
- a first-attempt success never prints the word "attempt"
- a synchronously-throwing `describe()` still produces a report
