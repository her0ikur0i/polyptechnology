# M5 — Security review, README, close

Date: 2026-08-11. Status: **done**.

## The review ran before the push, and it found things

New standing rule from the owner: `/security-review` runs _before_ the push and
anything it finds is fixed first. This is the first contract to follow it, and
it was worth it immediately.

**Security verdict: no findings.** The reviewer traced every value this diff
newly puts on the wire and confirmed:

- The new SQL — `LEFT JOIN LATERAL`, the `CASE`-guarded `::uuid` casts —
  contains no `${}` interpolation at all. Every value is a bound parameter, and
  the guard operates on column expressions rather than host strings.
- Every new interpolation into a `parse_mode: HTML` message reaches Telegram
  through `renderReport()`, which escapes title, subject and every detail line.
  That covers the caught error string, owner conversation content used as a
  subject, and project display names. `trimSubject()` does not escape, but its
  only two callers do.
- The one place model output is sent unescaped correctly omits `parse_mode`
  entirely, so it is delivered as plain text.

## Three flaws below the security bar, fixed anyway

The owner's rule says fix what the review finds, and all three were introduced
by this contract.

**1. This contract could have silenced the report it exists to improve.**
`taskFinished` sent its report as a single un-split message. That was safe only
while every field in it was bounded — and M2 added a caught error string to it.
A driver throwing a stack trace would produce a message over Telegram's 4096
limit, the send would be refused, and the notifier's deliberately silent catch
would swallow it. "The task failed" becomes nothing at all.

Fixed twice over: `event.detail` is capped at 600 characters, and the report is
now sent through `splitForTelegram()` like every other outbound path.
`tests/run-notifier.test.ts` throws a 25,000-character error at it and asserts
a message still arrives, under the limit.

This is the sharpest finding of the review, and it is the same lesson the
repository already wrote down after the live probe: _a failure report that
fails to send is the worst bug a notifier can have._ This contract nearly
reintroduced it while fixing four other things.

**2. `trimSubject()` had the exact bug `safeCut()` was written to fix.** M4
added surrogate-safe splitting to `splitForTelegram` and then, forty lines
away, truncated subjects at a raw UTF-16 index. Owner questions contain emoji.
`trimSubject` now uses `safeCut` too, with a test.

**3. The uuid shape guard was both too loose and too strict.** `^[0-9a-f-]{36}$`
admits 36 dashes and rejects an uppercase uuid. Worst case was a cast error
failing `/runs` — not a security issue, but the guard exists precisely so one
odd value costs a label rather than the command. Replaced with a real uuid
pattern, case-insensitive.

## Gates

| Gate                                     | Result                                  |
| ---------------------------------------- | --------------------------------------- |
| Backend suite, zero-skip invocation      | **353 tests, 353 passing, 0 skipped**   |
| Dashboard suite                          | 38 passing                              |
| `typecheck`, `format:check`, `npm audit` | clean, 0 vulnerabilities                |
| `verify-contract.ts CONTRACT-017B`       | structure and scope OK                  |
| `resume-checkpoint.ts --check`           | current                                 |
| `/security-review`                       | no findings; 3 robustness fixes applied |

353, up from 332: +5 `retry-backoff`, +9 `report-consistency`, +7 in
`run-notifier`, minus adjustments in the two rewritten command-handler tests.

## README

Rewritten as part of closing, per the new standing rule. It now points at
`docs/RESUME.md` first, states the zero-skip invocation with the reason it
matters, describes Telegram as the control surface it has become, and records
the conventions a newcomer would otherwise violate — one commit per contract,
evidence files as the done-signal, review before push, and the `runOne()`
sharing hazard.

## Live

Release `20260811T020128Z-contract017b-reporting` is deployed and
`polyp-sequence.service` is running it. The M1 backoff drill ran against it and
produced exactly one Telegram message for six attempts.
