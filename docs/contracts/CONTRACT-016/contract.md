# CONTRACT-016 — Streaming foundation for conversation replies

Status: complete — M0 through M5 done, all gates green (221 backend tests,
0 skipped; 38 dashboard), redeployed to private staging. Descoped by Amendment 1
below; the remainder lives in CONTRACT-017 and CONTRACT-018.

## Amendment 1 (2026-08-10, owner-requested)

The owner asked for Telegram to be prioritised: every run report, success or
failure, delivered to Telegram, and every confirmation approvable there.

Rather than reorder milestones inside this contract, everything after the
streaming foundation is **descoped**, and this contract closes on what is
already built and working. The pattern is CONTRACT-011's Amendment 2, which
descoped its M4–M10 into CONTRACT-012 for the same reason: a contract that keeps
absorbing new priorities never ships, and its uncommitted working tree keeps
growing.

- **Stays here (done):** M0 confirmation gate, M1 streaming provider invocation,
  M2 durable reply chunks, M3 driver writing chunks. Plus M4 (negative tests and
  review of what this contract actually shipped) and M5 (release), renumbered
  from the original M10/M11.
- **Descoped to CONTRACT-017:** Telegram notifications and approvals — now the
  next contract, at the owner's request.
- **Descoped to CONTRACT-018:** the SSE route, the client that consumes it,
  markdown rendering, the composer, per-message attribution, and thread
  virtualization. These complete the chat experience on top of the foundation
  this contract lays.

**Honest consequence, stated rather than buried:** the streaming machinery ships
inert. The adapter streams, fragments are stored durably, and nothing reads them
yet. Replies still work exactly as before — they simply arrive whole, because
`ManagedCompletion.content` was always the source of truth and chunks were
always disposable progress. Chunks written during a reply are cleared when it
completes, so nothing accumulates. That is a deliberately safe place to pause,
and it is the reason pausing here was possible at all.

## Objective

Close the gap the CONTRACT-015 audit named between "chat works" and "chat is
good". CONTRACT-014 made the conversation workspace real — send, background
reply, attachments, proposal, approve, generate — but it polls every 1.5 seconds
and renders every reply as raw text, so an answer containing code arrives as a
flat wall. Goal 2 measures this dashboard against claude.ai; this contract is
where that comparison stops being embarrassing.

It also opens Telegram as a full conversational entry point, at the owner's
explicit choice of the deeper option
(`docs/contracts/CONTRACT-015/evidence/M0-owner-confirmation.md` §4).

## Depends on

CONTRACT-014 (accepted): the conversation/message/attachment/proposal routes,
`ConversationReplyDriver`, and the reply-task queueing this contract makes
stream. CONTRACT-015 (accepted, `4b55447`): the rate limiter every new route
inherits, `src/dashboard/validation.ts`'s boundary parsers that every new
response must extend, and the single path guard.

## The architectural finding this contract is shaped by

Three facts, established by reading the code before drafting rather than
assumed:

1. **Chat replies route to Claude through the CLI adapter**, not to DeepSeek
   over HTTP (`src/gateway/model-policy.ts`, task class `orchestration`:
   `claude-sonnet-5`, escalating to `claude-opus-5`). `ClaudeCliAdapter` invokes
   with `execFile` and `--output-format json`, which buffers the entire
   completion before returning a single value.
2. **The reply is produced in a different process from the one that will serve
   the stream.** `ConversationReplyDriver` runs inside
   `polyp-sequence.service` (`src/orchestrator/sequence-main.ts`); the SSE
   connection is held by the Control API. Tokens have to cross a process
   boundary.
3. **`conversation_messages` has no notion of a partial message**
   (`migrations/0005_orchestrator.sql`): a row exists only once the reply is
   complete.

The consequence is that token streaming cannot be bolted onto the client. It
requires the adapter to stream, the chunks to be durable so they can cross
processes and survive a restart, and only then an SSE route to tail them.

**The rejected alternative, recorded because it is the tempting one:** running
the reply inline in the Control API request would make streaming trivial. It is
refused. CONTRACT-014 M2 deliberately made replies a background task and never
inline, and an inline reply loses durability, loses the work-engine's leasing
and budget accounting, and ties a costed provider call to the lifetime of a
browser connection. A progress bar is not worth breaking the execution model.

**The lesser alternative, also rejected:** streaming only state transitions
(queued → running → succeeded) over SSE without token text. It would be a real
improvement over polling and a fraction of the work, but it is not what goal 2
asks for, and the owner's standing instruction on this class of work is
explicit: _"tentu saja nyata, we're doing real work here, not dummy."_

## Scope

- **A streaming path through the provider layer.** `ManagedProviderAdapter`
  gains an optional streaming invocation. `ClaudeCliAdapter` implements it by
  moving from `execFile` to `spawn` and consuming the CLI's incremental output
  instead of one buffered JSON blob. An adapter that does not implement it
  degrades honestly — one chunk containing the whole completion — rather than
  pretending to stream. Budget reservation, usage accounting, and verification
  in `AiGateway` keep working unchanged; a stream that fails mid-flight must
  settle the ledger exactly as a failed non-streaming call does.
- **Durable chunk persistence.** A new migration adds incremental reply storage
  so the supervisor can write tokens as they arrive and the Control API can read
  them from another process. Chunks are ordered, append-only, and reconciled
  into the final `conversation_messages` row on completion, so a restart mid-
  reply resumes rather than losing the answer or double-appending it.
- **SSE on the Control API**, replacing the 1.5-second poll — the first
  server-side SSE in this codebase, establishing the pattern CONTRACT-017's
  Factory Live producer reuses. Owner-authenticated and rate-limited like every
  other route, with reconnection that resumes from the last received chunk
  rather than restarting the answer.
- **Markdown rendering with syntax-highlighted code blocks and per-block copy**,
  using established libraries. Rendering model output is an injection surface:
  it must not be able to inject HTML, script, or styling into the dashboard.
- **A real composer**: autosizing input, Enter to send with Shift+Enter for a
  newline, stop, regenerate, and edit-and-resend. Optimistic echo of the owner's
  own message, and error recovery that keeps the typed text instead of
  discarding it.
- **Per-message model attribution and cost**, read from the gateway ledger that
  already records them, so the owner can see which tier answered and what it
  cost without leaving the conversation.
- **Virtualized thread rendering**, so a long conversation stays responsive.
- **Telegram as a full conversational entry point**: run-state and gate
  notifications, budget alerts, approvals carrying real context rather than a
  bare button, and holding an actual conversation with the factory from
  Telegram.
- **Negative tests and an independent security review** of the two new
  boundaries specifically: rendered model output, and Telegram as a second
  ingress for untrusted text.
- Evidence reconciliation, staging redeploy, exactly one commit, and push.

## Out of scope

The design-system replacement (CONTRACT-018) — this contract delivers behaviour
on the current visual language, so a behaviour regression and an appearance
change can never be confused for one another. The Factory Live event producer
(CONTRACT-017), which reuses this contract's SSE pattern rather than sharing its
milestones. Multi-stack generation (CONTRACT-019). Domains and detach
(CONTRACT-020). Streaming for DeepSeek and Codex adapters beyond the honest
single-chunk fallback — chat routes to Claude, and building streaming for
providers this contract never streams through would be speculative. Starting
`polyp-sequence.service` on staging: that authorizes real costed provider calls,
which CONTRACT-013 M9 decision 4 deliberately withheld and no owner grant has
since extended.

## Milestones

0. M0: **owner confirmation gate — the only checkpoint, and it runs first.**
   Records the streaming architecture decision above and its two rejected
   alternatives, confirms scope, and notes that redeploy/commit/push authority
   was already granted in advance for every contract in the roadmap.
1. M1: streaming provider invocation — interface, `ClaudeCliAdapter` over
   `spawn`, honest single-chunk fallback for adapters without it, ledger
   settlement unchanged on mid-stream failure.
2. M2: durable chunk storage and reconciliation into the final message row,
   including restart mid-reply.
3. M3: `ConversationReplyDriver` writes chunks as they arrive.
4. M4: negative tests and an independent review of the streaming path — the
   adapter's spawn transport, the coalescing writer, and the durable chunk
   store. (Renumbered from M10 by Amendment 1; the rendered-model-output and
   Telegram-ingress halves of the original M10 move with their features.)
5. M5: evidence reconciliation, staging redeploy, one commit, push.
   (Renumbered from M11.)

**Descoped by Amendment 1** — the original M4–M9 now live in CONTRACT-017
(Telegram) and CONTRACT-018 (SSE route, client, markdown, composer,
attribution, virtualization).

## Gates

Revised by Amendment 1 to cover only what this contract ships. The gates about
browser rendering and the Telegram authority boundary move with their features
to CONTRACT-018 and CONTRACT-017 respectively — they are not dropped, and
restating them here against work this contract does not contain would be the
kind of green gate that means nothing.

- Fragments reach the provider's consumer through the **real** streaming
  transport — `ClaudeCliAdapter` over `spawn` with `--output-format
stream-json` — never simulated, and never a buffered completion revealed in
  one step.
- An adapter that does not implement streaming emits **no** deltas at all,
  rather than being wrapped in a fake that replays the finished answer.
- A reply that fails mid-stream settles the budget ledger exactly as a failed
  non-streaming call does — no orphaned reservation, no unaccounted spend, and
  no half-written message row, because accumulated fragments are never the
  answer.
- A storage failure while writing progress loses at most a fragment and never
  the reply.
- The full suite, dashboard suite, `typecheck`, `format:check`, `npm audit`,
  and `verify-contract.ts` all pass with zero skips, measured with the standing
  zero-skip invocation.

## Acceptance

Revised by Amendment 1. The owner-visible acceptance criteria all belonged to
the descoped work and move with it — this contract is foundation, and claiming
owner-visible acceptance for machinery nobody can see yet would be dishonest.

- The provider streams for real: a reply produced through `ClaudeCliAdapter`
  emits fragments during generation rather than at the end, and the fragments
  are durable enough for a different process to read.
- Nothing about the existing conversation experience regresses. Replies still
  complete, still cost what they cost, and still append exactly once — the
  streaming path is additive and inert until CONTRACT-018 consumes it.
- A future consumer can resume mid-answer after a disconnect, because chunks
  carry ordinals and are queryable as "everything after N".

CONTRACT-018 inherits the owner-visible criteria: watching an answer appear as
it is written, code blocks formatted and copyable, stop and regenerate,
Enter/Shift+Enter, per-reply attribution and cost, and a long thread that
scrolls without stalling. CONTRACT-017 inherits the Telegram ones.

## Rollback

Revert the commit. The new migration adds tables rather than altering
`conversation_messages`, so reverting the code leaves completed conversations
intact and only orphans any in-flight chunk rows, which carry no authority and
can be dropped. The SSE route is additive; the previous poller path is removed
by this contract, so a revert restores it wholesale. Staging rolls back by
repointing the release symlink and restarting, the procedure CONTRACT-013 M9
established and CONTRACT-015 M9 used.

## File ownership

- `docs/contracts/CONTRACT-016/**`
- `docs/contracts/CONTRACT-017/contract.md`
- `docs/product/**`
- `docs/architecture/**`
- `docs/security/**`
- `docs/operations/**`
- `docs/RESUME.md`
- `CLAUDE.md`
- `src/dashboard/**`
- `src/control-api/**`
- `src/orchestrator/**`
- `src/operations/**`
- `src/gateway/**`
- `src/telegram/**`
- `src/work/**`
- `migrations/**`
- `tests/**`
- `package.json`
- `package-lock.json`

`docs/contracts/CONTRACT-017/contract.md` is a narrow, explicit exception:
drafting the next contract's charter as part of closing this one, exactly the
allowance CONTRACT-011 made for `docs/contracts/CONTRACT-012/contract.md`. It
does **not** extend to CONTRACT-017's evidence or implementation files, which
belong to that contract and its own commit.
