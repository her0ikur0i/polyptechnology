# M3 — The reply driver writes chunks as they arrive

Date: 2026-08-10. Status: **done**.

## What changed

`ConversationReplyDriver` now passes an `onDelta` into `AiGateway.execute()`
and writes the fragments through `CoalescingChunkWriter` into the durable
storage M2 added. `sequence-main.ts` wires the real
`PostgresReplyChunkStore` in, because that process — `polyp-sequence.service` —
is where the driver actually runs.

## Coalescing, and why it is not premature optimisation

`onDelta` is synchronous and fires per fragment; a chatty provider produces
hundreds a second. One `INSERT` each is wasteful anywhere and genuinely
unaffordable on a 2-vCPU host shared with Postgres and Docker.

`CoalescingChunkWriter` batches by size (240 bytes) **and** by time (200 ms),
whichever comes first. Both halves are load-bearing:

- size alone would strand a slow trickle until the provider finished, which is
  exactly the experience streaming exists to remove;
- time alone would still fire far too often under a fast provider.

The owner cannot perceive the difference between 20 and 200 updates a second.
The database can.

Writes are serialized through a promise chain rather than fired in parallel:
ordinals must land in order, and an unbounded fan-out of inserts is precisely
the flood this class exists to prevent. The flush timer is `unref`'d so pending
progress can never hold the supervisor process open past its work.

## Failure choices, all in the same direction

Every one of these resolves toward "keep the answer, lose the progress":

- **`push()` never throws.** It is called from inside a live provider stream; a
  storage failure propagating from there would abort a real answer to protect a
  progress indicator. Failures are counted and exposed as `failedWrites` so a
  caller can record degraded progress rather than discover silence later.
- **`flush()` runs in a `finally`**, including when the gateway call failed. A
  stream that died still queued writes, and leaving them pending would strand
  fragments in memory and keep the write chain alive after the task moved on.
- **`clear()` is best-effort and outside the message append.** A cleanup failure
  must never be able to undo a completed reply; retention sweeps by age catch
  anything left behind.
- **The chunk store is an optional constructor argument.** A deployment without
  it still replies, just without progressive display. Streaming must never be
  load-bearing for correctness.

## Verification

`tests/reply-chunk-writer.test.ts` — 7 tests, no database needed because the
sink is an interface: ten 5-character fragments become 3 writes rather than 10,
with the text neither lost nor reordered; ordinals sequential and gapless; the
trailing partial fragment written on flush; flush safe with nothing pushed;
empty fragments ignored; a failing write costing one fragment and not the
answer; and a slow trickle flushed by the timer instead of held until the end.

Full backend suite, standing zero-skip invocation:

```
# tests 212
# pass 212
# fail 0
# skipped 0
```

212 = 205 after M2 + 7 new. `npm run typecheck` clean. `npm run format:check`
clean repository-wide.

Two typechecker findings were real and fixed rather than silenced: the
`ReplyChunkStore` interface had been inserted into the middle of the import
block, and `exactOptionalPropertyTypes` correctly refused a `timer` field
declared with `?` and later assigned `undefined`.
