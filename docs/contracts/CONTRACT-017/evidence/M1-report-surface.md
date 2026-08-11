# M1 — The report surface

Date: 2026-08-10. Status: **done**.

`src/telegram/report.ts` is new: one place that decides how this system speaks
to the owner through Telegram. `TelegramApprovalGateway.deliver()` now renders
through it, so this is the real path rather than a parallel presentation layer.

## What the owner asked for, and what each part became

**"Summary, more human readable"** → outcome first. The first line is
`<icon> <bold title>` and has to answer "do I need to act?" on its own, because
these are read on a phone while doing something else. Context goes on line two,
detail below that, numbers last.

**"Icons for each category"** → a fixed vocabulary, not decoration. Sixteen
entries mapping one-to-one onto meanings that recur: ✅ success, ❌ failure,
⚠️ warning, ⏳ running, 🛑 stopped, 📋 approval, 🤖 model, 🎟 tokens, 💰 cost,
📊 budget, 🔨 build, 🔒 gate, 🚀 deploy, 📦 project, 📄 contract, 🚨 incident.
Fixed meanings are what make a chat history scannable without reading every
word; icons chosen per-message would be worse than none.

**"Include token usage and budget"** → a usage block (`provider`, `model`,
tokens in/out/cached, cost) and a budget block, both drawn from figures the
gateway ledger already records. Cached tokens are omitted entirely when zero
rather than shown as `0 cached`, because a line that is usually noise trains the
eye to skip the line that sometimes is not.

**"Confirmation as buttons so I just tap"** → `renderApproval()` returns the text
and an inline keyboard together. The `callback_data` shape is exactly what
`parseTelegramCallback()` already validates (`approve:<43-char token>`), so the
buttons work the moment M3's poller lands rather than needing a second change.

## Presentation decisions that are really engineering decisions

**HTML, not MarkdownV2 or plain text.** Recorded in full in
`M0-owner-confirmation.md` §4 — three escape characters instead of eighteen,
which is what makes structure affordable after the CONTRACT-016 probe failure.

**The budget bar is ten cells.** Telegram has no progress widget and a bare
percentage does not convey "nearly gone" at a glance. It fills by `floor`, not
`round`: at 95% a rounded bar shows ten filled cells, and a full bar has to mean
exhausted or it stops meaning anything.

**Evidence is capped at 1,200 characters inside a `<pre>` block.** Telegram
refuses messages over 4,096 characters. A failure report rejected for length
fails exactly when it matters most, so trimming the evidence always beats losing
the report.

**Approval expiry is shown in minutes remaining, not as an ISO timestamp.** The
previous message said `Expires: 2026-08-10T03:27:15.000Z`, which is a
timestamp a human has to do arithmetic on. "Expires in 28 min" is the same fact
in the form the decision actually needs.

## Two of my own defaults were wrong, and the tests caught both

**Sub-cent rounding.** `formatUsd` used two decimals above one cent, so a
$0.0184 reply rendered as `$0.02`. Per-message costs are routinely under two
cents; two decimals turns most of them into `$0.02` or `$0.00`, which is not a
number anyone can add up. Now four decimals below $1, two above.

**The budget bar at 95%.** `Math.round(95 / 10)` is 10, so a nearly-exhausted
budget drew a completely full bar — the one reading it must never give falsely.
Now `Math.floor`.

Both were written as assertions of intent before the code was checked against
them, which is why they failed loudly rather than shipping as plausible-looking
output.

## Verification

`tests/telegram-report.test.ts` — 12 tests. The ones that carry real weight:

- **The escaping surface is exactly three characters.** Quotes and apostrophes
  must survive intact (escaping them would show literal entities to the owner),
  and `&` must be replaced first or the other two escapes get double-escaped.
- **A report quoting paths and identifiers survives** — the exact content shape
  (`src/gateway/cli-adapters.ts (invokeStreaming)`, `a_b_c *not italics*`) that
  broke the live probe under MarkdownV2.
- **Evidence containing `</pre><b>injected</b>` cannot break out of its code
  block**, since evidence is the field most likely to carry hostile or
  machine-generated text.
- **A zero budget limit does not divide by zero**, because that would crash a
  failure notifier at precisely the moment it is needed.
- **An already-expired approval reports 0 min, never a negative number.**
- **The `callback_data` shape matches what `parseTelegramCallback()` validates**
  — changing it silently would break every tap.

Full backend suite, standing zero-skip invocation:

```
# tests 233
# pass 233
# fail 0
# skipped 0
```

233 = 221 baseline + 12 new. `typecheck` clean, `format:check` clean
repository-wide.

## Delivered live, not just tested

Three messages were sent to the owner's real chat through the real transport:
a success summary with usage and budget, a failure report with a `<pre>`
evidence block, and an approval preview with buttons.

The approval preview carries an explicit warning **inside the message** that
its buttons are not wired until M3/M4. Sending tappable buttons that silently do
nothing would have been a small dishonesty in a surface whose entire purpose is
that the owner can trust what it tells them.
