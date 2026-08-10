# CONTRACT-017 — Telegram as a working control surface: reports, approvals, conversation, commands

Status: draft

## Objective

Make Telegram a real second seat at the console. The owner asked for four
things, in this order of insistence: every run report — success **and** failure —
delivered to Telegram; every confirmation approvable there; the ability to hold
a conversation with the factory; and the ability to give it commands.

Prioritised ahead of the rest of the chat work at the owner's explicit request
(2026-08-10), which is why CONTRACT-016 was descoped by its Amendment 1 rather
than left to absorb this.

## Depends on

CONTRACT-006/010 (accepted): `src/approvals/**` — the approval record, the
single-use expiring identity-bound token, and the decision service. `src/telegram/gateway.ts`
(176 lines today): `TelegramApprovalGateway.deliver()`, `parseTelegramCallback()`,
`handleTelegramCallback()`. CONTRACT-015 (accepted): the rate limiter and the
timing-safe webhook secret comparison. The live probe recorded in
`docs/contracts/CONTRACT-016/evidence/telegram-live-probe.md`, which established
that the stored credentials work and the bot is `@PolypTech_bot`.

## The finding that makes this contract possible without a cutover

Telegram's **webhook** transport requires a publicly reachable HTTPS endpoint.
The staging instance is loopback-bound on `127.0.0.1:4180`, and public exposure
is explicitly outside the standing owner authority — it belongs to CONTRACT-020
and needs fresh approval at the time. Taken naively, that would make inbound
Telegram impossible until after a public cutover, which is exactly backwards
from what the owner asked for.

**Long polling removes the problem entirely.** `getUpdates` is an _outbound_
call: the system asks Telegram for messages instead of Telegram delivering them.
No inbound port, no public hostname, no DNS change, no new trust boundary.

Verified against the live bot on 2026-08-10 before drafting this contract:
`getWebhookInfo` reports no webhook URL set, and `getUpdates` returns
successfully. The two transports are mutually exclusive — Telegram refuses
`getUpdates` while a webhook is registered — so choosing long polling also means
**never calling `setWebhook`**, and the existing webhook route stays exactly as
it is for a future deployment that does have public ingress.

## The authority boundary, stated before the scope

The owner asked for commands over Telegram. That makes Telegram an authority
channel, and `docs/architecture/adr-0002-conversation-authority-boundary.md`
governs it. The rule this contract will not bend:

> A Telegram-originated message gains exactly the authority the same message
> typed into the dashboard would gain, and not one step more.

Concretely, and these are constraints on the design rather than aspirations:

- A Telegram message becomes a **conversation message** — untrusted text, the
  same classification and the same handling as one typed into the workspace.
- **Nothing executes because it was asked for in a chat.** Work still reaches
  execution only through the existing `draft → owner_review → approved →
handed_off` proposal gate.
- "Commands" therefore means a **closed set**: read-only status queries, and
  decisions on approvals and proposals that already exist and already require an
  owner's answer. Not arbitrary instruction, not shell, not "run this".
- Every inbound update is identity-checked against the authorized chat and user
  IDs before it is even parsed as a command, because the channel is the
  credential here.
- Approval decisions keep the existing single-use, expiring, identity-bound
  token semantics. Telegram becomes a way to _answer_ an approval, never a way
  to mint one.

## Scope

- **A notification surface.** There is none today: `TelegramApprovalGateway` can
  deliver an approval and nothing else. Reports go out for run state
  transitions, verification-gate results, contract and task completion, budget
  thresholds, and incidents — **failures included, not only successes**, since a
  channel that only reports good news is worse than no channel.
- **Plain-text formatting, deliberately.** The live probe's first attempt failed
  on MarkdownV2 escaping, because report text quotes file paths, parentheses and
  identifiers constantly. A failure report that itself fails to send, precisely
  when something is wrong, is the worst possible bug in a notifier. Either
  escape rigorously or send plain text; this contract sends plain text and says
  so.
- **Inbound long polling.** A poller that runs in the supervisor process,
  survives restarts by persisting its update offset, backs off on failure, and
  never lets a Telegram outage affect anything else.
- **Approvals answerable from Telegram**, end to end, against a real pending
  approval — reusing the existing token and identity checks rather than adding a
  parallel path.
- **Conversation from Telegram**: a message becomes a real conversation turn,
  routed through the same `queueConversationReply` path the dashboard uses, with
  the reply delivered back to the chat.
- **A closed command set**: status, active runs, pending approvals, budget, and
  answering a specific approval or proposal. Anything outside the set is refused
  with a message saying so, rather than interpreted.
- **Negative tests and an independent security review** of the ingress
  specifically — identity spoofing, replayed callbacks, oversized or hostile
  message content, command injection through argument text, and the ADR-0002
  boundary re-verified against the implementation rather than assumed.
- Staging configuration, redeploy, evidence reconciliation, one commit, push.

## Out of scope

Calling `setWebhook` or any public exposure — the whole point of long polling is
that this contract needs neither. Group chats and multi-user access: this is a
single-owner system and the authorized-identity check is the security model.
Rich media, inline queries, and bot menus. Streaming a reply token-by-token into
Telegram — the chat UI's streaming consumer is CONTRACT-018's work, and Telegram
receives completed replies. Starting `polyp-sequence.service` for real costed
provider calls, which remains withheld: conversation from Telegram queues a
reply task exactly as the dashboard does, and that task executes only where and
when execution is already authorized.

## Milestones

0. M0: owner confirmation gate — records the long-polling decision, the closed
   command set, and the authority boundary above. Redeploy/commit/push authority
   is already granted in advance for every contract in the roadmap.
1. M1: the notification surface and its plain-text formatter, with delivery
   failures that degrade rather than break the work being reported on.
2. M2: notifications wired to real event sources — run transitions, gate
   results, completion, budget thresholds, incidents.
3. M3: inbound long polling with a persisted offset, backoff, and isolation from
   the rest of the supervisor.
4. M4: approvals answerable from Telegram against a real pending approval.
5. M5: conversation from Telegram, routed through the existing reply path.
6. M6: the closed command set, with anything outside it refused rather than
   interpreted.
7. M7: negative tests and an independent security review of the ingress and the
   authority boundary.
8. M8: staging configuration, redeploy, evidence reconciliation, one commit,
   push.

## Gates

- A failing run produces a Telegram report. Proven by making something fail, not
  by asserting the happy path.
- A report containing file paths, parentheses and code identifiers is delivered
  intact — the exact content shape that broke the live probe's first attempt.
- A pending approval can be answered from Telegram and the decision is recorded
  with the same token semantics as one answered anywhere else. A replayed
  callback is refused.
- An update from an unauthorized chat or user is refused before its content is
  interpreted.
- A message asking the factory to do something dangerous produces a
  conversation turn and, at most, a proposal — never execution. Re-verified
  against this implementation, not assumed from ADR-0002.
- Telegram being unreachable degrades notifications only: no task fails, no
  reply is lost, no gate changes result.
- Full suite, dashboard suite, `typecheck`, `format:check`, `npm audit`, and
  `verify-contract.ts` pass with zero skips, measured with the standing
  zero-skip invocation.

## Acceptance

- The owner learns from Telegram that a run succeeded or failed, without opening
  the dashboard.
- The owner can approve or reject a pending decision from their phone, and the
  system records it exactly as if they had clicked in the dashboard.
- The owner can ask the factory a question in Telegram and get a real answer
  back in the chat.
- The owner can ask for status, active runs, pending approvals, or budget and
  get them.
- Asking for anything outside the command set gets a plain refusal that names
  what is available.

## Rollback

Revert the commit. Long polling is a client of Telegram's API, so stopping the
poller is sufficient to stop all inbound processing; no webhook was ever
registered, so nothing external needs unwinding. Notifications are outbound and
stateless. The persisted update offset is the only durable state this contract
adds beyond configuration; dropping it causes at most a replay of recent updates,
which the identity check and the single-use approval tokens already refuse
safely.

## File ownership

- `docs/contracts/CONTRACT-017/**`
- `docs/product/**`
- `docs/architecture/**`
- `docs/security/**`
- `docs/operations/**`
- `docs/RESUME.md`
- `CLAUDE.md`
- `src/telegram/**`
- `src/control-api/**`
- `src/orchestrator/**`
- `src/operations/**`
- `src/approvals/**`
- `src/config.ts`
- `migrations/**`
- `deploy/**`
- `tests/**`
- `package.json`
- `package-lock.json`
