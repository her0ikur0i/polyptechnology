# M6 — The closed command set

Date: 2026-08-11. Status: **done**, proven live against the real staging
database with every command and every refusal delivered to the owner's chat.

## What "closed" means here

Five commands, all read-only: `/status`, `/runs`, `/approvals`, `/budget`,
`/help`. Anything else that begins with `/` is **refused, not interpreted** —
no fuzzy matching, no "did you mean", no falling through to the assistant.

Three properties are deliberate and each one is a decision, not an omission:

- **Arguments are dropped, not parsed.** `/status --all please` runs `/status`.
  A closed set that quietly accepted parameters would not be closed.
- **`/stat` is refused**, not resolved to `/status`. The nearest-match behaviour
  everyone expects from a CLI is exactly where a control channel starts doing
  things nobody asked for.
- **`/approvals` mints no buttons.** Approval tokens are single-use and
  identity-bound and are issued when an approval is _delivered_. Minting a fresh
  one because someone typed a command would turn a read-only listing into a way
  to create authority. The owner answers on the original message.

The refusal names the whole set, then says plainly that anything else should
just be said in a normal message — a refusal that leaves the owner guessing what
they were allowed to type is a worse answer than the command would have been.

This survives Amendment 1 unchanged. The assistant gained tools; the command
surface did not, because a command is answered **without a model in the loop**
and therefore without any judgement about what was meant.

## The read model, tested against the real schema

`src/telegram/command-facts.ts` holds every query the owner can trigger. It is
read-only by construction: there is no method on it that changes anything.

The unit tests (`tests/telegram-command-handler.test.ts`, 11 tests) feed the
renderer a hand-written fake, so they prove only that the renderer agrees with
its author. Every defect this contract has actually shipped came from the layer
below — a handler matching outcome strings the database never produces, a store
whose idempotency check could not succeed twice. So the read model gets its own
integration tests against the real schema
(`tests/telegram-command-facts.integration.test.ts`, 10 tests):

| Test                                         | What would otherwise rot silently                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| every `ACTIVE_STATES` entry is a legal state | a state renamed in a migration stops matching `= ANY(...)`, and /status reports idle    |
| activeRuns joins spec and live lease         | the `LEFT JOIN`s and every column name in them                                          |
| an expired lease reports no worker           | naming a worker that stopped heartbeating sends the owner to a process that is gone     |
| pendingApprovals drops the expired           | listing an approval whose buttons no longer work                                        |
| status counts what /approvals lists          | two WHERE clauses, one truth — they drifted apart once already, in the approval handler |
| status reads the newest finalized attempt    | a typo in `max(finalized_at)` renders as _absent_, not as an error                      |
| budget arithmetic, spent vs reserved         | `bigint` arrives from `pg` as a string; `"12345"` would render as `$12345.00`           |

The first of those is the one worth keeping. It inserts a task in each
`ACTIVE_STATES` value inside a transaction and rolls back, so the `tasks.state`
check constraint is the authority rather than a comment. Verified to fail on
drift by adding a bogus state:

```
not ok 1 - every ACTIVE_STATES entry is a state the schema actually allows
  error: 'ACTIVE_STATES contains a state tasks.state does not accept:
           new row for relation "tasks" violates check constraint "tasks_state_check"'
```

Assertions are relative, never absolute — the test database is shared, and a
test asserting "two active runs" would pass alone and fail in the full run.

## Live drill

Release `20260810T234444Z-contract017-commands` deployed, `current` repointed,
`polyp-sequence.service` restarted. Nine updates shaped exactly like Telegram's
own payloads, put through `originOf()` and the real handler, against real
staging data, delivered by the real API:

```
/help                    delivered in 868 ms
/status                  delivered in 449 ms
/runs                    delivered in 397 ms
/approvals               delivered in 385 ms
/budget                  delivered in 398 ms
/status@PolypTech_bot    delivered in 409 ms
/status --all please     delivered in 400 ms
/deploy production now   delivered in 783 ms
/stat                    delivered in 383 ms
```

Every one accepted by Telegram. That is the M1 trap re-tested: report text
quotes paths, uuids and identifiers constantly, and the live probe's first
attempt ever made died on MarkdownV2 escaping. HTML parse mode with three
escaped characters holds.

What the owner saw, unedited:

```
📄 Commands
/status — overall factory state
/runs — what is executing right now
...

⏳ 3 active
3 retry_wait
no approvals waiting
last provider call 12 h ago
📊 ░░░░░░░░░░ 1% · $4.94 left of $5.00

🔨 conversation_reply — retry_wait
  47a0ed46 · attempt 1/3 · $0.00

🛑 Not a command
/deploy production now is not in the command set, so nothing was run.
```

`/status@PolypTech_bot` and `/status --all please` produced output identical to
`/status`, and `/stat` produced the refusal — the three parsing decisions above,
observed rather than asserted.

## What the drill found

**The command surface did its job immediately: it reported a defect nobody knew
about.** `/runs` showed three `conversation_reply` tasks in `retry_wait`, due by
13 to 23 hours, one of them a question the owner asked in Telegram yesterday and
never got an answer to.

Cause and fix are recorded in `evidence/retry-sweep.md`. It is not a Telegram
bug — it is a work-engine bug that only became visible once the owner could ask
the factory what it was doing from their phone, which is the entire argument for
this contract.

A second finding, **not fixed here**: three `ai_gateway_attempts` rows sit in
`outcome_unknown` holding **$0.60 reserved** against a $5.00 scope. Releasing
them is `scripts/reconcile-provider-attempt.ts`, which by design demands an
evidence SHA — inventing one to free the money would corrupt exactly the audit
record that makes the ledger worth having. Recorded in `docs/RESUME.md` under
known issues, alongside the identical CONTRACT-008 leftover.

## Gate status

- Full suite: reported at M8 with the closing reconciliation.
- `tests/telegram-command-handler.test.ts` + `tests/telegram-command-facts.integration.test.ts`:
  **21 tests, 21 passing, 0 skipped** under the standing zero-skip invocation.
- Live process exercised this milestone, per the standing rule that integration
  tests are not enough to prove a server boots.
