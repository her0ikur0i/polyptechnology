# M4 — Approvals answerable from Telegram

Date: 2026-08-10. Status: **done**, proven by a real tap from the owner's phone.

## One decision path, not two

`TelegramApprovalUpdateHandler` routes a button tap through the **same**
`TelegramDecisionService` the webhook route uses. `PostgresTelegramDecisionService`
was module-private in `telegram-webhook.ts` and is now exported rather than
duplicated.

Two ways to approve something is how they drift, and the one that drifts is the
one nobody is testing. The handler adds only what a tap needs that an HTTP POST
does not: answering the callback so the button stops spinning, and rewriting the
message so a decided approval stops looking actionable.

`surfaceOf()` is deliberately separate from `parseTelegramCallback()`. The
latter extracts what the authorization decision needs and refuses anything that
is not `approve|deny` plus a 43-character token; the former reads which message
to edit. Mixing "which message do I edit" into a security boundary would be a
bad trade for a few saved lines.

## The bug the owner found by tapping twice

The owner tapped Approve, then tapped it again — and could, because the buttons
had not disappeared.

**`ApprovalRepository.decide()` returns `"decided"` on success and `"replayed"`
on a repeat.** This handler was checking for `"approved"` and `"denied"` —
strings that are never produced anywhere in the system. The branch that removes
the buttons therefore never ran, and the toast read `Recorded: decided`.

The unit tests passed throughout, because the fake decision service returned the
same invented strings. **The test agreed with the author's assumption rather
than with the system.** This is the second occurrence of that exact failure
within two days; the first was inventing the Claude CLI's stream event shape in
CONTRACT-016. Both were invisible to the suite and immediately visible in a real
run.

The reason is now recorded in the code beside the outcome list, pointing at
`src/approvals/postgres-repository.ts` as the source of truth, so the next
person to add a value goes and reads it first.

What the record showed underneath the broken UI, which is the part that
mattered:

```
status: approved   decided_by: 519329092   decided_at: 12:36:49
```

The second tap was processed and refused. `decided_at` never moved. The
single-use token held even while the interface was lying about it.

## What changed

- `"decided"` clears the buttons and posts a confirmation reply.
- **The confirmation says Approved or Denied based on the button pressed**, not
  on the outcome — `"decided"` does not say which way, and showing "Approved"
  for a deny would be the worst confusion this surface could produce.
- `"replayed"` shows "Already decided" as an alert the owner must dismiss, not a
  toast they might miss.
- An outcome this build does not recognise leaves the approval looking
  undecided. Silently presenting an unknown result as done is the one wrong
  answer available.
- Both Telegram failure paths now **log** instead of swallowing in silence.
  That silence is exactly what hid this: live buttons on a decided approval,
  with nothing anywhere saying so.

## Verified live, twice

First drill, before the fix: decision recorded correctly, buttons stayed.

Second drill, after the fix: the owner tapped once and the buttons disappeared.

```
CONTRACT-017 M4 live approval drill              approved  519329092  12:36:49
CONTRACT-017 M4 retry — buttons should now clear approved  519329092  12:46:55
```

No `telegram.settle.failed` or `telegram.answer.failed` in the journal, so the
edit and reply genuinely succeeded rather than failing quietly again — which is
only checkable because those paths now log.

## Verification

`tests/telegram-approval-handler.test.ts` — 8 tests, now written against the
real outcome vocabulary: a tap records a decision and clears the buttons; a deny
settles as Denied in both the toast and the reply; a malformed token never
reaches the decision service; a replay alerts and leaves the message alone; a
non-callback update is ignored rather than erroring; a Telegram failure after
the decision does not throw; **the tapping user's id reaches the decision, not
the chat owner's** (passing the chat id would let anyone in an authorised chat
approve as the owner); and an unrecognised outcome is never treated as a
decision.

Full backend suite, standing zero-skip invocation:

```
# tests 265
# pass 265
# fail 0
# skipped 0
```

265 = 257 after M3 + 8 new. `typecheck` clean, `format:check` clean
repository-wide.
