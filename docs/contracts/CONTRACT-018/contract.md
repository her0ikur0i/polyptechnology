# CONTRACT-018 — Chat experience on the streaming foundation

## Objective

Make the dashboard's chat window the thing the owner actually works in.

Goal 2 of the five is a chat window comparable to claude.ai, and goal 4 is that
the dashboard is a primary daily workspace rather than a throwaway. Today the
conversation workspace posts a message and waits for a whole reply to appear.
Every piece needed to do better already exists and is unused:

- **CONTRACT-016 M1** made adapters stream, and `ManagedCompletion.content` the
  single source of truth for a reply.
- **CONTRACT-016 M2/M3** made progress durable: `conversation_reply_chunks`,
  `CoalescingChunkWriter`, and `PostgresReplyChunkStore.since(taskId, after)` —
  a query written for one caller, the SSE route, which does not exist yet.
- **CONTRACT-017A** made a turn cost what a turn costs, so a long thread is
  worth keeping open instead of being something the owner learns to avoid.

This contract builds the consumer of all three.

## What is already true, and narrows this contract

- The chunk store is finished and tested. `since()` is exactly
  resume-from-last-chunk, and its ordinals come from a single sequential
  writer, so the server side of resumption is a route, not a design problem.
- Chunks are **progress, not record**. Nothing here may rebuild a message by
  concatenating them; the promoted message is the answer. A stream that dies
  leaves rows nobody promotes, and that is by design.
- `src/dashboard/conversation-workspace.tsx` (803 lines) already renders a
  thread, composes a message, and handles attachments and proposals. This
  contract evolves it. It is not a rewrite.

## M0 — Owner confirmation

Two of this contract's three questions were answered in advance, in the batch
taken before CONTRACT-017B (`docs/contracts/CONTRACT-017B/evidence/M0-owner-confirmation.md`):

1. **Layout: single column, claude.ai-like**, with everything else behind a
   collapsible left rail.
2. **Chain mode:** 017B → 017A → 018 run unattended, stopping only for DNS,
   secrets, public exposure, irreversible actions, or a failed gate.

The third is the one the owner explicitly reserved: **they see a rendered
mockup before any UI is written.** That decision was recorded as "which one
gets built, not whether it gets reviewed", so M0 is not complete until the
mockup has been shown and answered. It is the only checkpoint in this contract.

Standing rules apply unchanged: `/security-review` before the push, `README.md`
updated at close, commits authored `heroikuroi`, and a successful push rolls
straight into CONTRACT-019.

## Scope

- **Control API SSE route** for a conversation reply in progress, resuming from
  a client-supplied last ordinal via `PostgresReplyChunkStore.since()`. Auth,
  CSRF and rate-limiting consistent with every other route; absent
  configuration means the route is not registered, never that it is open.
- **Progressive rendering** in the client: the reply appears as it is produced,
  and a reconnect resumes rather than restarting.
- **Markdown rendering that cannot inject.** Model output is untrusted. Raw
  HTML is not rendered, and this is proven by tests that feed hostile content —
  script tags, `javascript:` URLs, event-handler attributes, CSS escapes — and
  assert what reaches the DOM, rather than trusting a library's reputation.
- **Syntax-highlighted code blocks with per-block copy.**
- **A real composer:** autosize, Enter to send and Shift+Enter for a newline,
  stop, regenerate, edit-and-resend, optimistic echo, and error recovery that
  preserves what was typed.
- **Per-message attribution:** which model answered and what it cost, read from
  the ledger rather than recomputed in the client.
- **Virtualized thread rendering**, so a long conversation stays responsive —
  the conversations 017A made affordable are the ones that get long.

## Out of scope

- **The design-system replacement — CONTRACT-020 owns it.** This contract
  delivers behaviour on the current visual language, so a behaviour regression
  and a restyling can never be confused for one another.
- **Shipping a deliberate typeface**, for the same reason. The comment in
  `src/dashboard/styles.css` that names this "CONTRACT-018's job" predates the
  roadmap split and is wrong; correcting that comment is in scope, acting on it
  is not.
- Cloudflare Access JWT verification (CONTRACT-020) and Factory Live's missing
  producer (CONTRACT-019).
- Any change to how a reply is produced. 016 and 017A own that; this contract
  consumes it.

## Milestones

0. M0: owner confirmation — the two answered questions recorded, plus a
   rendered mockup shown and answered.
1. M1: Control API SSE route, resuming from a last-ordinal cursor.
2. M2: the client consumes it and renders progressively, including reconnect.
3. M3: markdown and code rendering, proven non-injecting against hostile input.
4. M4: the composer — autosize, send semantics, stop, regenerate,
   edit-and-resend, optimistic echo, typed-text-preserving error recovery.
5. M5: per-message model attribution and cost from the ledger.
6. M6: virtualized thread rendering.
7. M7: live drill in the real dashboard, README, security review, close.

## Gates

- A reply renders progressively in the real dashboard, not only in a test.
- Killing the connection mid-reply and reconnecting resumes from the last
  ordinal received, without duplicating or restarting the text.
- A message whose content is hostile markdown renders as visible text and
  executes nothing — asserted against the DOM.
- A failed send leaves the typed text recoverable, never discarded.
- Per-message cost matches the ledger, not a client-side estimate.
- Full suite, dashboard suite, `typecheck`, `format:check`, `npm audit`,
  `dashboard:build`, `verify-contract.ts CONTRACT-018`, and
  `resume-checkpoint.ts --check` pass with zero skips.
- `/security-review` runs clean, or its findings are fixed before the push.
- The server is run as a live process at least once — an integration test has
  already failed to prove a server boots in this repository.

## Acceptance

- The owner can hold a long working conversation in the dashboard in
  preference to Telegram.
- A reply is visible while it is being written.
- Nothing a model emits can execute in the owner's browser.

## Rollback

Revert the commit. The SSE route is additive and the client changes are
confined to the dashboard bundle; reverting restores the current
post-and-wait workspace, which keeps working throughout.

## File ownership

- `docs/contracts/CONTRACT-018/**`
- `docs/product/**`
- `docs/RESUME.md`
- `README.md`
- `CLAUDE.md`
- `migrations/**`
- `src/control-api/**`
- `src/dashboard/**`
- `src/orchestrator/**`
- `package.json`
- `package-lock.json`
- `scripts/**`
- `tests/**`
