# M5 — Conversation from Telegram

Date: 2026-08-10. Status: **done**, proven by a real conversation from the
owner's phone, including one turn the assistant answered by reading this
repository.

## One conversation per chat, not one per message

`telegramConversationKey(chatId)` derives a stable idempotency key, and the
project and conversation ids derive from it the same way `OwnerCommandService`
derives them. Nothing stores a chat-to-conversation mapping; both sides compute
it, which is what lets the notifier know which conversation's replies belong in
the chat without a lookup table that could drift.

A chat is a continuous thread, so a Telegram message joins the existing
conversation rather than starting a new one. That is not merely convenient: a
per-message conversation would give the assistant no memory of the previous
turn, which is the opposite of what a chat is for.

## The bug that made the handler silent

Calling `startConversation()` on every message _looked_ idempotent, because the
key is stable. It is not. The store compares the whole **intent**, and
`occurredAt` changes on every call — so the first Telegram message created the
conversation and every message after it was rejected with "idempotency intent
mismatch" before anything else could run. No reply, and no acknowledgement
either, because the throw happened first.

The handler now looks the conversation up and creates only if it is absent.

## The second silent failure, in a different layer

The Telegram handler deliberately routes through `OwnerCommandService` rather
than touching the stores, so the same `authorize()` and the same validation run.
It stored messages correctly — and never produced a reply.

**Half the behaviour lived in the Express route.** `POST /messages` appended the
message and then called `queueConversationReply()` itself. Any second caller
that went through the service, precisely to avoid building a weaker second door,
got the append and not the queueing.

The sequence — append, then queue — now belongs to `OwnerCommandService`, with
the mechanism injected. The route no longer queues; it reads the
`replyTaskId` the service returns.

The general form is worth keeping: **when a domain sequence lives in a transport
handler, the second transport silently gets half of it.** Not a wrong result — a
missing one, which is harder to notice.

## The answer's way back

`TelegramRunNotifier` is given the Telegram conversation's id. When a
`conversation_reply` task finishes, `replyFor()` checks the task's input
`conversationId` against that id and delivers the assistant's answer to the chat
instead of a "Task succeeded" report.

Scoped that way on purpose: every dashboard conversation also produces
`conversation_reply` tasks, and echoing those into Telegram would turn the chat
into a firehose of someone else's conversation.

The reply is a background task, so `⏳ Working on it…` goes out immediately. A
failure to send that acknowledgement is logged and does not undo the stored
message or the queued reply.

## What the owner changed, and what it cost to make work

The interviewer-only posture was overruled by the owner on 2026-08-10: the
assistant reachable from Telegram is meant to be genuinely capable, not a
suggestion box. It now runs with tools inside this repository. **The authority
consequences are recorded in Amendment 2 to `contract.md`, not here** — this
section is about what it took to make it run.

Five failures, each found by running it and none by the suite:

1. **`claude_max_turns`.** Investigating with tools costs turns — read a
   directory, grep a file, read the file, answer. The four-turn default was
   sized for a conversational reply. Raised to 12 when tools are on.
2. **`actual cost exceeds reservation`.** A tools-enabled turn reads a lot more
   than a chat turn, and the reservation was sized for the latter.
3. **`--dangerously-skip-permissions cannot be used with root/sudo`.** The CLI
   refuses that flag outright as root. Tools are enabled through an explicit
   `--allowedTools` list instead, which is a better answer than the one that was
   blocked: the permitted set is written down rather than "everything".
4. **`ReferenceError: WebAssembly is not defined`**, mid-run, right after a real
   reply. `MemoryDenyWriteExecute=true` is incompatible with a JIT, `--jitless`
   was the workaround, and `--jitless` also disables WebAssembly — which Node's
   bundled undici needs for `fetch`. Both are off, with the reasoning in the
   unit file: this unit runs _our_ code, while untrusted AI-authored code
   executes in the Docker sandbox with `--read-only`, `--cap-drop=ALL` and
   `--network=none`.
5. **`MemoryMax=512M` killed the parent**, because the provider CLI is a child
   Node runtime charged to the same cgroup. Raised to 1500M.

## The stale-transcript problem, and why the prompt has a fingerprint

Changing the system prompt did not change the assistant's behaviour, because the
prompt is not the only thing the model reads: the whole conversation history is
replayed into every request, **including the assistant's own past turns**. The
old thread still contained replies saying "I cannot read files", and the model
stayed consistent with its own transcript — answering a question correctly by
reading the repository, then two turns later denying it could read anything.

Both turns are in the record:

```
10:48  assistant  Ada 17 contract di docs/contracts/ (CONTRACT-001 sampai 017)…
10:49  assistant  Saya tak punya kemampuan eksekusi apa pun di sini…
```

The second one is false, and it was produced nine seconds of wall clock after
the first one proved it false.

`SYSTEM_PROMPT_FINGERPRINT` is a 12-character hash of the prompt text, and it is
part of the conversation key. **Changing the prompt therefore starts a fresh
thread automatically**, instead of depending on someone remembering that old
turns now contradict the new instructions. A prompt change is a change of who
the assistant is; inheriting a transcript that argues otherwise is not memory,
it is contradiction.

`effort` for the `orchestration` class dropped from `high` to `medium` in the
same pass. Conversation is read on a phone and ten seconds for a simple question
is too slow; the escalation tier is still there for turns that need it.

## Verified live

From the owner's phone, against the running `polyp-sequence.service` and the
staging database, after the prompt change:

| Turn                                         | What it proves                                        |
| -------------------------------------------- | ----------------------------------------------------- |
| "berapa jumlah file .ts di src/telegram/?"   | Clear request → direct answer ("6"), no interrogation |
| "tolong bersihkan kode yang tidak perlu"     | Ambiguous request → one focused question, no action   |
| "apa saja kemampuan anda?"                   | Answers from the repository, not from imagination     |
| "buat file CRUD-PROOF.txt … lalu konfirmasi" | Wrote the file and reported exactly what it wrote     |

The write drill counted 81 `.md` files under `docs/contracts` with `find` and
wrote `WRITE_VERIFIED 81`. The scratch file was removed afterwards; the point
was the capability, not the artifact.

Judgement between the first two rows is the part worth noting. The same
assistant answered one question immediately and refused to guess at the other,
which is the behaviour the prompt asks for and the reason it is worded as
"judge intent before acting" rather than "always ask" or "always do".

## Verification

- `tests/owner-message-queues-reply.test.ts` — 4 tests covering the sequence the
  route used to own: a stored message queues a reply at the advanced version, a
  failed append queues nothing, a service constructed without the mechanism
  queues nothing and says so, and the returned `replyTaskId` reaches the caller.
- `tests/streaming.test.ts` — extended for `--include-partial-messages`,
  including the duplicate complete-message guard that flag introduces.
- `tests/conversation-reply.integration.test.ts` — unchanged and still passing
  against the real database.

Full backend suite, standing zero-skip invocation:

```
# tests 276
# pass 276
# fail 0
# skipped 0
```

276 = 265 after M4 + 11 new. `typecheck` clean.

## Spend

Real provider spend to date on this contract's live work: **$0.7701** across 24
recorded usage events (12,960 input / 6,355 output tokens), all `claude`. Three
`ai_gateway_attempts` rows remain in `outcome_unknown` — the three failures
listed above, which are a truthful record of what happened and are left as-is
rather than tidied away.
