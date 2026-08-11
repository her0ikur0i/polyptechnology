# M4 — Retiring the prompt fingerprint

Date: 2026-08-11. Status: **done**.

## What it was for, and why it can go

`telegramConversationKey()` included a hash of the system prompt, so editing
the prompt started an entirely new thread. That existed because of a real
failure: the model read its own past turns saying "I cannot read files", stayed
consistent with them, and denied being able to read the repository **nine
seconds after** correctly counting 17 contracts in it.

The cause was never the prompt. It was whole-transcript replay — every request
re-sent every previous turn, including assistant turns written under older
instructions. Forking the thread fixed the symptom by throwing away the owner's
history.

M2 removed the cause. A resumed turn sends only the new message, so there is
nothing old in the request to argue with the instructions. The key is now just
the chat: **one chat, one thread**, and editing a sentence in the prompt no
longer costs the owner their history.

## The case that survives, stated rather than hidden

A **cold start** — no stored session, first turn after an expiry — still
replays the full history, which may contain turns written under a previous
prompt. The mechanism that produced the original bug is therefore not gone; it
is narrower.

So the prompt now asserts its own precedence:

> These instructions are current and take precedence. If anything earlier in
> this conversation contradicts them — including your own previous replies
> about what you can and cannot do — treat this message as correct and those
> as out of date.

That is weaker than deleting the transcript and stronger than nothing, and it
is the honest trade: the owner keeps their thread, and the one path that can
still replay a contradiction is told explicitly which side wins.

A stricter fix exists — record the prompt version alongside each message and
drop assistant turns authored under a different one from a replay. It needs a
schema column and it is not this contract's scope. Recorded here rather than
implemented, because a residual risk that is written down is manageable and one
that is quietly assumed away is not.

## One last thread reset

Removing the fingerprint changes the derived key, so the owner's current
Telegram thread is replaced **once**, on the next message. After that it is
stable for good. Worth stating plainly: the change that stops threads being
discarded discards one on its way in.

## Tests

`tests/telegram-conversation-handler.test.ts`, 11 passing.

The old test asserted the property this milestone removed — that the key
changes with the prompt — and it kept passing afterwards, because it compared
two different chat ids and got two different keys. It was rewritten rather than
deleted: the key is now asserted **stable** across repeated derivation, and a
second test asserts the precedence sentence is actually in the prompt. A test
that passes for the wrong reason is worse than no test.
