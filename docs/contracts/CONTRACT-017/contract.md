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

## Amendment 1 (2026-08-10, owner-instructed) — the assistant is capable

**This amendment weakens a boundary this contract's own text said it would not
bend.** It is recorded at the top, in the contract, rather than left to a code
comment, because that is the difference between a decision and a drift.

The owner instructed that the assistant reachable from Telegram be genuinely
capable rather than an interviewer that can only ask questions and draft
proposals. As of M5 it runs with tools — read, write, run commands — inside
`/root/polyptechnology-next`, as root, under an explicit `--allowedTools`
list. The trade-off was put to the owner directly and they made the call for a
single-owner controlled machine.

What that changes, stated exactly:

- The bullet below reading "**Nothing executes because it was asked for in a
  chat**" no longer holds for the **assistant conversation** path. The assistant
  can change this repository if the owner asks it to in Telegram.
- It **still holds for the factory's generation pipeline**. ADR-0002's
  `draft → owner_review → approved → handed_off` gate is untouched: a
  conversation cannot cause a blueprint, a generated project, or a publication.
  `scripts/propose.ts` exists so the assistant's route into factory work is a
  proposal awaiting the owner's decision, and the system prompt tells it to
  prefer that over building the owner's product by hand.
- The **closed command set** (M6) is unchanged and still closed. Commands are
  not the capable path; conversation is. A command that is not in the set is
  refused, not interpreted.
- Identity checking is now load-bearing in a way it was not before. Previously
  an unauthorized message reaching the handler would have become an untrusted
  conversation message; now it would reach something that can act. The check
  runs in the poller, before parsing, against both chat and user id — M7 tests
  that boundary as the primary security surface of this contract.

The honest summary of the residual risk: **anything the owner can be talked into
asking for, the assistant can do**, and it does it as root. Reverting is
`ASSISTANT_TOOLS` in `sequence.env` plus two lines in the unit file.

## Amendment 2 (2026-08-11, owner-instructed) — the resume protocol, and what M0 already covers

Two sessions in a row ended with the connection dropping mid-milestone. Nothing
was lost either time, but only because the working tree survived — `docs/RESUME.md`
itself was wrong, claiming M5 had not started when its evidence file was already
written, and quoting a test count three milestones stale. A resume file that is
updated only when someone remembers is not a protocol.

- **`docs/RESUME.md` is updated as the last step of every milestone**, not at
  the end of the contract. `scripts/resume-checkpoint.ts` regenerates the
  volatile part of it — milestone state from `evidence/M<n>-*.md`, `git log`,
  `git status` — so the update is mechanical and cannot silently rot.
- The owner reconfirmed on 2026-08-11 that the standing M0 authority covers, for
  the remainder of this contract: applying migration `0015` to the **real**
  staging database, restarting `polyp-sequence.service`, live Telegram drills
  that spend real provider money, and the single commit and push at M8. It still
  excludes DNS, public exposure, secrets, production promotion, and
  `polyptech-dashboard.service`.

**Session-based continuity is explicitly deferred to CONTRACT-017A**, by owner
decision on 2026-08-11. Conversation history today is unbounded: every turn
replays the entire transcript, so cost climbs with thread length and a long
enough thread will eventually be refused by the provider. `SYSTEM_PROMPT_FINGERPRINT`
(`src/operations/conversation-reply-driver.ts`) is a workaround for one symptom
of that design — a stale transcript contradicting a changed prompt — not a fix
for the design. The real fix is storing a provider session id per conversation
and resuming it. That touches `src/gateway/**` and needs a schema column, so it
is its own contract rather than a widening of this one at M6 of M8.

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
handed_off` proposal gate. **Revised by Amendment 1 above**: this still governs
  the factory's generation pipeline, and no longer governs what the assistant
  itself can do in this repository at the owner's instruction.
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
- **Reports that read like a summary, not a log dump.** Added at the owner's
  request (2026-08-10): outcome first, a category icon on every line that has a
  category, and **token usage and budget inside the report itself** — the
  numbers already recorded by the gateway ledger, surfaced where the owner
  actually reads them instead of only in a dashboard they would have to open.
- **HTML parse mode, not plain text and not MarkdownV2.** This revises the
  earlier plain-text decision, which was made in reaction to the live probe's
  MarkdownV2 failure and traded away all structure to avoid it. MarkdownV2
  requires escaping about eighteen characters and report text quotes file paths,
  parentheses and identifiers constantly, which is why it broke. **HTML mode
  needs exactly three** — `<`, `>`, `&` — so bold, `code` spans and hierarchy are
  available at a fraction of the fragility. Every interpolated value passes
  through one escaper; a failure report that itself fails to send, precisely
  when something is wrong, remains the worst bug this surface can have.
- **Confirmations as buttons.** Inline keyboards so the owner taps rather than
  types. `TelegramApprovalGateway.deliver()` already sends
  `approve:<token>`/`deny:<token>` buttons and `parseTelegramCallback()` already
  validates the token shape; what is missing is the context around them — what
  is being approved, what it will cost, and what budget remains — so a decision
  can be made from the message alone.
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
- `resume-checkpoint.ts --check` passes — `docs/RESUME.md` agrees with the
  evidence actually on disk. A milestone is not closed until it does.

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
- `src/gateway/**`
- `src/control-api/**`
- `src/orchestrator/**`
- `src/operations/**`
- `src/approvals/**`
- `src/config.ts`
- `migrations/**`
- `deploy/**`
- `scripts/**`
- `tests/**`
- `package.json`
- `package-lock.json`

`src/gateway/**` is here for a reason worth stating rather than assuming.
CONTRACT-016 closed believing its streaming path was finished. Turning the
supervisor on for real showed it was not: `--output-format stream-json` emits
complete assistant messages, so the first live reply arrived as one
938-character blob rather than a stream. The fix — `--include-partial-messages`,
plus a guard against the duplicate complete message that flag also produces —
lands here because this is the contract that ran the thing and found out.
Reopening a closed contract to hold it would have been worse bookkeeping and no
better engineering.

`scripts/**` holds the two operator entry points this contract adds:
`propose.ts`, the assistant's only route from a conversation into factory work
(Amendment 1), and `resume-checkpoint.ts`, which regenerates the resume state
(Amendment 2).
