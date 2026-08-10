# M1 — Streaming provider invocation

Date: 2026-08-10. Status: **done**.

## What changed

`ManagedProviderAdapter` gained an **optional** `invokeStreaming()` with the
same contract as `invoke()` — same validation, same `ManagedCompletion`, same
failure semantics — plus an `onDelta` callback that receives fragments as the
provider emits them. `GatewayRequest` gained a matching optional `onDelta`.

`AiGateway.execute()` uses the streaming path only when the caller asked for
deltas **and** the selected adapter genuinely implements it. Everything
downstream of that choice — model-resolution checks, rejection codes, usage
validation, ledger settlement — is byte-identical either way, because
`invokeStreaming()` returns the completion `invoke()` would have returned. That
convergence is the whole point: a streamed answer must not be able to reach the
ledger through a different path than a buffered one, or the two drift and only
one stays tested.

`ClaudeCliAdapter` implements it with `--output-format stream-json` over
`spawn`. `execFile` cannot stream by construction — it resolves only at exit —
so this is a genuine transport change, not a flag flip.

## The design decision that shapes everything after it

**Chunks are disposable progress. `result.content` is the answer.**

The final `result` event of `stream-json` carries the identical envelope that
`--output-format json` returns as its whole stdout, so both paths converge on
one `completionFrom()` for validation and accounting. There is exactly one copy
of that logic: duplicating it is precisely how the CONTRACT-011 Claude CLI
envelope incident happened.

Three consequences follow, and they are what make the rest of this contract
safe:

- A stream that dies mid-answer leaves **no half-written record anywhere** —
  there is nothing to reconcile, because accumulated deltas were never the
  answer.
- Ledger settlement on mid-stream failure is unchanged, because failure happens
  at exactly the same point it always did.
- An adapter without streaming is **never wrapped in a fake one**. It emits no
  deltas at all. Simulating them would be a lie the UI tells; the caller can
  tell the difference by their absence rather than by a flag it must remember
  to check.

## A real gap the typechecker caught

The first version of `invokeStreaming()` ignored `maxOutputTokens`, which
surfaced as an unused-parameter error. That was not a lint nuisance — it pointed
at a real omission: `invoke()` bounds its output through `execFile`'s
`maxBuffer`, and the streaming path bounded nothing. On a 7.8 GB host a
misbehaving provider could have grown this process without limit.

Delta forwarding is now bounded by the same ceiling `invoke()` uses
(`max(1_000_000, maxOutputTokens * 8)`). Past it, fragments stop being
forwarded and the answer simply stops appearing to grow; the result envelope
still decides what the answer is, so nothing is lost but the progress illusion.

## Other deliberate choices

- **A malformed progress line is skipped, not fatal.** Killing a live answer
  over one unparseable line would trade a real completion for a cosmetic
  guarantee. If the envelope never arrives, the missing-envelope check fails
  closed anyway.
- **stdout is reassembled across chunk boundaries.** A socket read can split a
  JSON line in half; the partial line is carried forward rather than parsed and
  dropped.
- **stderr is bounded at 64 kB.** A provider that fails loudly must not be able
  to grow this process's memory.
- **Only two event types are read** — `assistant` for text and `result` for the
  envelope. Reacting to more of a format we do not control would couple us to
  it.

## Verification

`tests/streaming.test.ts` — 6 tests:

- deltas are emitted in order and the completion comes from the envelope, with
  the assertion written so it is clear which of the two the code trusts;
- a malformed line is skipped and the answer still completes;
- a stream that never produces a `result` event fails closed with the CLI's
  exit code and last stderr line;
- delta forwarding stops at the ceiling (three 400 kB fragments pass, the
  fourth is refused);
- an adapter without `invokeStreaming` produces **no** deltas and is invoked
  through the ordinary path exactly once;
- a streamed answer settles the ledger with the same outcome, route and cost
  accounting as a buffered one.

Full backend suite, standing zero-skip invocation:

```
# tests 199
# pass 199
# fail 0
# skipped 0
```

199 = 193 baseline + 6 new. `npm run typecheck` clean. `npm run format:check`
clean repository-wide.
