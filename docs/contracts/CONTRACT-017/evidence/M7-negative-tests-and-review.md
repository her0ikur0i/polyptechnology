# M7 — Negative tests and a review of the ingress and the authority boundary

Date: 2026-08-11. Status: **done**. One real defect found and fixed, one gate
verified for the first time, and one script proven to have never worked as
written.

## Why this milestone changed shape

M7 was specified before Amendment 1. At that point the worst a hostile update
could achieve was an unwanted conversation message. Since Amendment 1 the
assistant answering these messages has `Bash`, `Write` and `Edit` inside this
repository, **as root**. The identity check stopped being hygiene and became the
security boundary, which is what the amendment says in as many words.

So the review focused on two questions: can anything reach the capable path
without being the owner, and does the proposal gate actually hold.

## Finding 1 — the ingress read missing configuration as permission (fixed)

`TelegramUpdatePoller.authorized()`:

```ts
const chatOk = this.authorizedChatIds.length === 0 || …
const userOk = this.authorizedUserIds.length === 0 || …
```

**An empty allow-list accepted every update.** Any chat, any user, straight
through to a handler that can change this repository.

Not reachable in production: `sequence-main.ts` constructs the poller only when
`TELEGRAM_CHAT_ID` and `TELEGRAM_USER_ID` are both set, so the lists are never
empty there. That is the reason it is a finding rather than an incident — and
also the reason it was worth fixing. The guarantee lived in the _caller_, and
`CLAUDE.md` states the opposite rule as an invariant:

> **Fail closed.** Absent configuration means a route is not registered at all,
> not that it accepts anonymous callers.

The poller now requires a present, matching id on both axes. Absent
configuration refuses everything. Two tests added:

- `an empty allow-list refuses everything rather than accepting everything`
- `an update missing an identity is refused, not treated as anonymous`

The second closes the adjacent hole: an update with no `from` (Telegram channel
posts have none) previously satisfied `userOk` by way of the empty-list branch.

## Finding 2 — the proposal gate, verified rather than assumed

The contract's gate says a dangerous request produces at most a proposal,
"re-verified against this implementation, not assumed from ADR-0002".
`tests/proposal-gate.integration.test.ts` runs **the real script**, the way the
system prompt tells the assistant to run it, against the real database:

| Assertion                                     | Result                             |
| --------------------------------------------- | ---------------------------------- |
| state after `propose.ts`                      | `owner_review` — before the gate   |
| `approval_id` on the proposal                 | `null` — nothing was approved      |
| `blueprint_translation` tasks for the project | 0 — nothing was handed off         |
| a conversation id that does not exist         | refused, non-zero exit             |
| `../../etc/passwd`, `1; DROP TABLE tasks`     | refused on shape, before any query |

The gate holds. `draft → owner_review → approved → handed_off` is intact and the
assistant's only route into factory work stops at the owner's decision.

## Finding 3 — `propose.ts` had never printed a proposal id

The first execution of this script in its life, in the test above, returned:

```json
{ "state": "owner_review", "note": "Awaiting the owner's approval…" }
```

No `proposalId`. It read `proposal.id` from `OwnerCommandService.draftProposal()`,
which returns `proposalId`. So the assistant, told to draft a proposal and
report back, could only ever have told the owner that _a_ proposal existed
somewhere — with no id to approve it by.

Fixed, and the test now asserts the id matches a uuid rather than merely being
truthy.

Worth stating plainly: this script is the safety story of Amendment 1. It was
written, wired into the system prompt, documented in the contract as the reason
tools are acceptable — and never once run. **A control that has never been
exercised is a claim, not a control.**

## Finding 4 — the capable path had no tests at all

`src/telegram/conversation-handler.ts` is the only Telegram surface that can
cause action, and it had zero unit tests. `tests/telegram-conversation-handler.test.ts`
adds 10, all negative or boundary:

- a slash message is left entirely to the closed command set — no double answer
- no text, empty text, whitespace, or a non-string body is ignored, never guessed
- 20 000 characters passes, 20 001 is refused here rather than thrown out of the
  command service
- an update with no chat id is dropped — no reply target, no identity
- the conversation is created only when absent (M5's idempotency bug, held shut)
- a failed acknowledgement never undoes a stored message
- a **refused** message never produces "⏳ Working on it…" — an acknowledgement
  for work that was not stored is a lie the owner then waits on
- the conversation key changes with the system prompt fingerprint, which is what
  stops a stale transcript contradicting a changed prompt

## Reviewed and found sound

- **Telegram HTML escaping** (`report.ts`): `&`, `<`, `>` escaped; values never
  land in attribute position, so quote escaping is not required. Every path that
  renders owner- or database-controlled text — approval summaries, scope ids,
  task ids, the refusal's echo of what was typed — goes through it.
- **Webhook secret comparison** (`control-api/telegram-webhook.ts`):
  `timingSafeEqual` over SHA-256 digests, so length never leaks and a mismatch
  cannot throw. The route is registered only when a secret is configured, and
  this deployment registers no webhook at all.
- **No secrets in argv**: the prompt travels on stdin. The bot token is in the
  API URL, as Telegram's protocol requires, and no error path logs the URL.
- **Approval tokens**: single-use and identity-bound, issued at delivery.
  `/approvals` deliberately mints none, so a read-only command cannot become a
  way to create authority.

## Residual risk, stated rather than mitigated

The assistant runs with `Bash` and `WebFetch` as root in this repository. Content
it fetches, and anything written into a conversation, is model input — and the
model can act. **Anything the owner can be talked into asking for, the assistant
can do**, which is exactly what Amendment 1 records. Nothing in this milestone
narrows that, and nothing should pretend to: the mitigation is that the ingress
admits exactly one chat and one user, which is why Finding 1 mattered enough to
fix even though it was unreachable.

The reduction available without an owner decision is the tool list itself —
`Write`, `Edit` and `Bash` are what make it capable, and `WebFetch`/`WebSearch`
are what make it reachable by third-party text. Narrowing that is an owner
choice about capability, not a defect, so it is recorded here rather than
changed.

## This review was not independent

CONTRACT-015 and 016 used a separate reviewer, and that is the practice this
milestone is supposed to follow. `/security-review` failed to launch here
(`origin/HEAD` was unset; now fixed with `git remote set-head`), and the review
was carried out by the same session that wrote the code. Recorded as a
limitation rather than glossed: the same author reviewing their own work is the
weakest form of this gate, and CONTRACT-015's own history is the argument — its
independent review found a critical bug that six passing tests had missed.

**Recommendation for M8 or CONTRACT-017A:** re-run `/security-review` now that
it launches, and treat any finding as a defect of this milestone.

## Test counts

| File                                          | Tests |
| --------------------------------------------- | ----- |
| `tests/telegram-poller.test.ts`               | 13    |
| `tests/telegram-conversation-handler.test.ts` | 10    |
| `tests/proposal-gate.integration.test.ts`     | 3     |

All passing, zero skipped, under the standing zero-skip invocation. The full
suite is reconciled at M8.
