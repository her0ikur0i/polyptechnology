# Evidence — retries that never happened

Date: 2026-08-11. Not a milestone: a defect found _by_ M6's live drill, fixed
because the contract's whole promise is that the owner can rely on this channel.

## How it surfaced

The first thing `/runs` ever printed against real data:

```
🔨 conversation_reply — retry_wait
  47a0ed46 · attempt 1/3 · $0.00
🔨 conversation_reply — retry_wait
  d0e26d29 · attempt 1/3 · $0.00
🔨 conversation_reply — retry_wait
  15e230ce · attempt 1/3 · $0.00
```

Three tasks, `attempt 1/3`, `next_attempt_at` **13 to 23 hours in the past**.
The command surface justified itself in its first minute of use: nothing else in
the system was ever going to say this out loud.

## The bug

`engine.ts` parks a failed attempt in `retry_wait` with a `next_attempt_at`.
`PostgresWorkRepository.controlTransition()` promotes `retry_wait → queued`, and
guards it correctly:

```sql
UPDATE tasks SET state=$3,next_attempt_at=NULL
 WHERE id=$1 AND state=$2 AND ($2<>'retry_wait' OR next_attempt_at<=CURRENT_TIMESTAMP)
```

**Nothing ever called it.** `ExecutableTaskSupervisor.runOne()` selects
`WHERE t.state='queued'` and nothing else. So `retry_wait` was terminal in
practice: every task that failed a single attempt stopped there permanently, and
silently — the failure had already been reported, and nothing reports a retry
that never comes.

The retry machinery was all present. It was written, tested, guarded, and
unreachable.

## The fix

`promoteDueRetries()` in `ExecutableTaskSupervisor`, called at the top of
`runOne()`. The SELECT only proposes candidates; `controlTransition()` re-checks
the state and the due time in one statement, so two supervisors racing cannot
both promote the same task and a task that stopped being due is refused rather
than retried early. Losing that race is the normal outcome, so it is ignored
rather than logged as an error.

`tests/retry-sweep.integration.test.ts` covers both directions against the real
database, and was confirmed to fail without the fix:

```
not ok 1 - a retry that has come due is picked up and run
    a due retry was never re-queued
```

### The test that fixed itself twice

Worth recording, because both mistakes are easy to repeat in this repository.

The first version drove `runOne()` in a loop. `runOne()` leases whichever
eligible task sorts first across the **whole shared test database**, so it
executed other suites' work with a driver map that could not serve it. The
tests were rewritten to call `promoteDueRetries()` directly — which is why that
method is public.

That was not enough. The fixtures themselves were valid queued work once
promoted, so `operations-postgres.integration.test.ts` started leasing _them_
and asserting against a summary belonging to a task it never created:

```
+   attemptOrdinal: 2,
+   evidenceSha256: 'ea203ba9…'
-   attemptOrdinal: 1,
-   evidenceSha256: '18a7dd8f…'
```

One failure in three runs, passing in isolation every time — the shape of flake
that gets re-run rather than fixed. The fixtures now open their contract as
`draft` rather than `active`: `promoteDueRetries()` ignores contract status so
promotion is still exercised, while `runOne()` joins `c.status='active'` and can
never lease them. Five consecutive runs of both files together, clean.

## What happened when it was deployed

Release `20260810T235238Z-contract017-retrysweep`. All three tasks moved within
one poll cycle: `retry_wait → queued → leased → running`, attempts 2 and 3, then
`failed` — the correct terminal state for a task that has exhausted its
attempts. Better than stuck, but not an answer, so the retries were traced
further.

Attempts 2 and 3 lasted **28 ms and 25 ms**, and produced **no
`ai_gateway_attempts` row at all**. No provider was called; no money was spent.

## The second defect, found on the way: the failure reason was thrown away

Every throw from every driver lands in one `catch` and becomes the string
`invalid_output`. The error itself was discarded. Diagnosing this took reading
five tables to _infer_ a cause the process had known exactly, held in a
variable, and dropped.

`supervisor.attempt.failed` is now logged with the task id, the attempt ordinal
and the error message. The durable record is unchanged — this is a log line, not
a schema change — but the next occurrence will not need archaeology.

This is the third time in this contract that a swallowed failure has cost real
time (the approval handler at M4, the conversation handler at M5). The pattern
is worth naming: **a failure path with no output is indistinguishable from
success at a distance.**

## The third defect, found and deliberately not fixed here

A retry of a `conversation_reply` **cannot succeed once the conversation has
advanced**, which is precisely when a retry matters.

The gateway's idempotency key is derived from the _task_
(`conversation-reply-<taskId>`) and survives every attempt, while the request
hash covers the transcript, which grows. So the retry finds the first attempt's
ledger row, sees a different `requestHash`, and throws:

```
idempotency intent mismatch
```

before reserving budget and before calling the provider. That is exactly the
25 ms with no ledger row. The three stuck rows are still there, one per task,
each holding its original reservation:

```
conversation-reply-d0e26d29-…  outcome_unknown  200000
conversation-reply-15e230ce-…  outcome_unknown  200000
conversation-reply-47a0ed46-…  outcome_unknown  200000
```

**This is the same bug shape M5 already fixed one layer up**, where
`startConversation()` was rejected with the identical message because its intent
included a field that changed on every call. Same lesson, second layer: an
idempotency key that outlives the thing it identifies turns a retry into a
guaranteed failure.

Not fixed here on purpose. Changing what the ledger considers one logical
attempt is an audit-semantics decision, and **CONTRACT-017A** — session-based
continuity — changes how the transcript enters the request in the first place,
which is the same seam. Fixing it now, at M6 of M8, would widen this contract
into the one that follows it.

## Fourth: $0.60 reserved and unreleased

Those three `outcome_unknown` rows hold **$0.60** reserved against a $5.00
scope, permanently reducing what is spendable. `scripts/reconcile-provider-attempt.ts`
releases them, and by design demands an evidence SHA — inventing one to free the
money would corrupt the audit record that makes the ledger worth having.
Recorded in `docs/RESUME.md` beside the identical CONTRACT-008 leftover.

## Proof the pipeline itself is healthy

A fresh message through the production wiring — the same `OwnerCommandService`,
conversation key, reply queueing and notifier that `sequence-main` builds:

```
owner      Drill: reply with the current git HEAD short hash of this repository
           and nothing else.                              23:57:10
assistant  b239fe1                                        23:57:18
```

Correct, from a real tool-using read of the repository, in **8 seconds**,
succeeded on attempt 1, delivered to the owner's chat. The three old tasks
failed for reasons specific to their own stale ledger rows, not because
`conversation_reply` is broken.
