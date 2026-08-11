# M0 — Owner confirmation gate

Date: 2026-08-10. Status: **done**.

## Authority

Already granted in advance for every contract in the roadmap
(`docs/contracts/CONTRACT-015/evidence/M0-owner-confirmation.md` §2), and
reaffirmed when the owner said to run the sequence until every contract is
finished. Redeploy, commit and push proceed without a further pause once gates
are green.

Unchanged exclusions: public DNS or Cloudflare cutover, public hostname
exposure, production promotion, `polyptech-dashboard.service`, and anything
secret-impacting or irreversible.

## Why this contract exists at all, and why now

The owner asked for Telegram to be prioritised on 2026-08-10, in four parts:
every run report — success **and** failure — delivered to Telegram; every
confirmation approvable there; the ability to hold a conversation with the
factory; and the ability to give it commands.

CONTRACT-016 was descoped by its Amendment 1 to make room, rather than reordered
internally. Reordering would have meant the owner receiving Telegram only when
that whole contract closed, while its uncommitted working tree kept growing —
the exact risk they had raised a few hours earlier when asking for the resume
protocol to be made robust.

## Decisions recorded

### 1. Long polling, and never `setWebhook`

Telegram's webhook transport requires a publicly reachable HTTPS endpoint. This
deployment is loopback-bound on `127.0.0.1:4180`, and public exposure sits
outside the standing authority — it belongs to CONTRACT-022 and needs fresh
approval at the time. Read naively, that would have made inbound Telegram
impossible until after a cutover, which is backwards from what was asked for.

`getUpdates` is an **outbound** call: the system asks Telegram for messages
rather than Telegram delivering them. No inbound port, no public hostname, no
DNS change, no new trust boundary.

Verified against the live bot before drafting: `getWebhookInfo` reports no
webhook URL set, and `getUpdates` returns successfully. The transports are
mutually exclusive — Telegram refuses `getUpdates` while a webhook is
registered — so this decision also means never calling `setWebhook`. The
existing webhook route stays untouched for a future deployment that does have
public ingress.

### 2. Commands are a closed set — owner-confirmed

The owner asked for commands, which makes Telegram an authority channel. The
boundary offered and accepted:

> A Telegram-originated message gains exactly the authority the same message
> typed into the dashboard would gain, and not one step more.

So: a Telegram message becomes an ordinary conversation message; nothing
executes because it was asked for in a chat; work still reaches execution only
through `draft → owner_review → approved → handed_off`; and "commands" means
status, active runs, pending approvals, budget, and answering decisions that
already exist and already require an owner's answer.

The owner was told plainly that a broader command set would remove the only gate
protecting the system, and replied that the closed set is sufficient
("himpunan tertutup sudah cukup").

### 3. Report presentation — added mid-contract at the owner's request

Reports must read as summaries rather than log dumps: outcome first, a category
icon on every line that has one, and **token usage and budget inside the report
itself**, drawn from figures the gateway ledger already records. Confirmations
must be buttons the owner taps.

### 4. HTML parse mode — this revises an earlier decision of mine

The contract originally said plain text, decided in reaction to the CONTRACT-016
live probe failing on MarkdownV2 escaping. That avoided the fragility by
throwing away all structure, which the owner's presentation request then needed
back.

MarkdownV2 requires escaping roughly eighteen characters, and report text quotes
file paths, parentheses and identifiers constantly — which is exactly why it
broke. **HTML mode requires three**: `<`, `>`, `&`. Bold, `code` spans and
hierarchy become available at a fraction of the risk, with every interpolated
value passing through one escaper.

Recorded as a revision rather than silently changed, because the plain-text
decision is written into this contract's own scope section and a future reader
would otherwise find the code and the charter disagreeing.

## Baseline locked before implementation

```
# tests 221
# pass 221
# fail 0
# skipped 0
```

Measured with the standing zero-skip invocation, at commit `324b39f`
(CONTRACT-016 closed). `scripts/verify-contract.ts CONTRACT-017`: structure and
scope OK.
