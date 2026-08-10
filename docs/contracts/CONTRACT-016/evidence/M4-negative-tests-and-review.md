# M4 — Negative tests and independent review of the streaming path

Date: 2026-08-10. Status: **done**.

Reviewed by a party that did not write the code, per `AGENTS.md`. The brief was
adversarial: attack the central claim, and treat "the tests are green" as no
evidence — the equivalent review in CONTRACT-015 found a critical bug that six
of the author's own passing tests had missed.

## The central claim survived a real attack

The whole design rests on one assertion: **accumulated deltas are never the
answer; `ManagedCompletion.content` is the only source of truth.**

The reviewer did not take it on trust. They traced `content` from
`completionFrom()` through `AiGateway.execute()` to `appendMessage()`, confirmed
the delta branch and the envelope branch are structurally disjoint paths sharing
only the NDJSON stream, confirmed `CoalescingChunkWriter` exposes no accessor
that could leak accumulated text even accidentally, and grepped the tree to
confirm nothing outside the tests reads chunks back at all.

Verdict: no path, current or latent, where fragments become or influence the
stored message or the ledger — and it holds under every failure mode they could
produce. Ledger equivalence likewise: both invocation styles funnel through one
shared reservation → dispatch → validate → settle block, with the streaming
ternary as the only branch point.

## Two HIGH findings, both real, both reproduced

### A retried task inherited its dead attempt's fragments

A retried `conversation_reply` task keeps its `task_id`, but every attempt built
a fresh writer whose ordinals restart at 1. `ON CONFLICT (task_id, ordinal) DO
NOTHING` therefore **preserved the failed attempt's fragments and silently
dropped the live one's** at every colliding ordinal — a reader would have seen a
splice of dead text followed by the real tail.

The reviewer reproduced it against the real database: writing "WRONG"/"STALE"
as a failed attempt, then "RIGHT"/"REPLY" as the retry, yielded
`WRONGSTALE!!!!!` instead of the actual answer.

The M2 evidence had justified `DO NOTHING` as protecting against a replayed
ordinal — true only for a _byte-identical_ replay, not for the
restart-at-1-with-different-content case retries actually produce. Blast radius
today is zero because nothing reads chunks, which is precisely why it had to be
fixed before CONTRACT-018 wires up a reader.

**Fixed:** the driver now clears this task's rows at the _start_ of every
attempt, best-effort and swallowed, matching the post-success clear's posture.

### A hung write could wedge the entire sequence worker

A _failing_ sink was already handled. A _hanging_ one — pool exhaustion, a lock,
a partition mid-query — was not. `flush()` runs in the driver's `finally`,
inside a worker that processes one task at a time, so a stuck write meant
`execute()` never returned, the lease renewed forever, the task never failed or
retried, and **no task of any kind was ever picked up again** until a force
kill. A graceful SIGTERM could not help: the shutdown signal reaches the spawned
CLI, not a stuck database call.

**Fixed:** `flush()` is bounded. A stuck write is abandoned, counted as a failed
write, and the chain is detached so a later flush is not held hostage.
Abandoning costs a fragment of progress; not abandoning costs the worker.

## Four MEDIUM findings, all fixed

- **A timeout kill was reported as a clean exit.** Node reports a SIGKILLed
  child as `code = null`, so `code ?? 0` recorded `exitCode: 0` for a process
  the runner had just force-killed, and **resolved** instead of rejecting. The
  buffered `execFile` path rejects in the equivalent case; the streaming path
  now matches, with a message naming the timeout.
- **stderr kept the head instead of the tail.** The cap refused to append once
  full, while the diagnostic reads the _last_ line — so 70 kB of noise followed
  by the real auth error discarded exactly the error. Now keeps the tail.
- **The line-assembly buffer was unbounded.** The delta ceiling only gates text
  _after_ a complete line is parsed; one unterminated 10 MB line grew RSS by
  ~142 MB with nothing to stop it at 100 MB either. Now capped, with the
  oversized fragment handed over to fail parsing honestly rather than dropped
  silently.
- **A duplicate index.** `UNIQUE(task_id, ordinal)` already creates the btree
  the SSE query needs; the explicit `conversation_reply_chunks_stream` was a
  second identical one, adding write cost to the very path the coalescing writer
  exists to keep cheap. Removed from the migration and dropped from the test
  database — `0014` is unreleased, so amending it beat stacking a `0015`.

## A claim withdrawn rather than quietly dropped

Both the migration and the driver cited "retention sweeps by age" as though it
were an implemented control. **It is not.** `src/operations/retention.ts` is a
policy validator with no notion of this table, and nothing schedules a delete.

Corrected in place in both files. What actually bounds growth today is stated
instead: the driver clears at the start of every attempt and again after
success, so a task leaves at most one attempt's fragments behind, and only if it
exhausts every retry. The `created_at` index stays, so the sweep CONTRACT-018
adds alongside the reader will not need a migration.

## One LOW finding, fixed for consistency

`parseConversationReplyTaskInput` validated four fields and blindly cast four
others — including `attribution`, whose `taskId` is now the key progress rows
are written and cleared by. `AiGateway.validate()` rejects only _empty strings_
in attribution, not missing keys, so an undefined `taskId` would have reached
SQL as `NULL` and failed quietly. Unreachable today, since
`queueConversationReply()` is the only producer; validated anyway so it fails
closed with a clear message rather than on incidental `NULL` semantics.

## A bug the fix itself introduced, caught immediately

The bounded `flush()` initially `unref`'d its timeout timer, copying the
periodic drain timer's pattern without thinking. An unref'd timer cannot hold
the event loop open, so when a stuck write was the only remaining work Node
drained the loop and the promise never settled — turning a bounded wait into a
permanent hang, the exact failure the bound existed to prevent. Three tests
failed with "Promise resolution is still pending but the event loop has already
resolved" the moment they ran. The drain interval stays unref'd; the flush bound
must not be, and the code now says why.

## Verification

New: `tests/stream-runner.test.ts` (6 tests, driving the real
`defaultStreamRunner` against real child processes) covering the timeout-kill
outcome, an ordinary non-zero exit, stderr tail retention with a 70 kB prefix,
the bounded giant line, split-line reassembly, and a missing binary.
`tests/reply-chunk-writer.test.ts` gained the hung-sink bound and the
chain-detachment case. `tests/reply-chunks.integration.test.ts` gained a
regression guard that demonstrates the collision hazard _and_ that clearing
first resolves it.

```
# tests 221
# pass 221
# fail 0
# skipped 0
```

221 = 212 after M3 + 9 new. Dashboard: 38. `typecheck` clean, `format:check`
clean repository-wide, `npm audit` 0 vulnerabilities.

## What the reviewer attacked and could not break

Recorded because it is as informative as the findings: ledger equivalence under
every producible failure mode; multi-byte truncation against the SQL `CHECK`
(JS `.slice()` in UTF-16 units is always conservative versus Postgres codepoint
length — forced a cut through a surrogate pair and through 70,000 emoji, both
inserted within bounds); ordinal correctness with reversed per-write latency;
`push()` never throwing under always-throwing and never-settling sinks, with no
unhandled rejection across every probe; the drain interval self-cancelling
rather than leaking; 20,000 rapid pushes flushing in 42 ms with no chain
degradation; split-line reassembly; `close` versus `exit` semantics; `kill()` on
an already-exited child; both `error` and `close` firing for one spawn without
double-processing; abort producing a real `AbortError` with no zombie left
behind; and the `conversations` foreign key being inert because conversations
are archived, never deleted.
