# M4 — Human labels, silence, and text that survives being cut

Date: 2026-08-11. Status: **done**.

## Names a person can read

A report used to be headlined by a uuid:

```
⚠️ Task retry_wait
47a0ed46-7dc2-44ec-835f-a32e44f616db
```

That is unreadable, unmemorable, and not something the owner can act on. Two
facts about a task are useful — what kind of work it is, and what it is about
— and both were already in the database, unused.

`src/telegram/task-label.ts` maps the driver enum to a word (`conversation_reply`
→ "Chat reply", `ai_patch_executor` → "Patch") and the report resolves a
subject from the work itself: the owner's own most recent question for a chat
reply, the project display name for a generation. A driver this build does not
recognise becomes "Task" rather than leaking its enum value into a message.

```
❌ Chat reply failed
"ada berapa contract pada project ini?"
```

The subject is quoted only when it is the owner's own words. A project name is
the system's noun and is not.

`/runs` uses the same naming, via LEFT JOINs added to `activeRuns()`. The uuid
casts there are guarded by a shape test, so one malformed `input` value costs a
label rather than failing the whole command with a cast error.

The id is not gone from the system, only from the headline. It remains wherever
it is needed to act on something.

## Silence about progress

`SILENT_OUTCOMES` holds exactly `retry_wait`. Three failing tasks now produce
three messages instead of six, and the M1 drill — five retries and one failure
— produced one message rather than six.

Lines that carry no information are dropped rather than rendered: the attempt
count appears only past the first attempt, spend only when something was spent,
reservations only when some exist.

## Text that survives being cut

`splitForTelegram` breaks at a paragraph, else a line, else a space — and when
none of those falls in the second half of the window, at the raw index. That
last branch is a UTF-16 code-unit offset, and every emoji outside the basic
plane is two of them, so a 4,000-character answer with no break point could be
cut through the middle of a 🔨 and both halves render as `�`.

`safeCut()` steps the boundary back one unit when it lands on a high surrogate.

The owner's pasted transcript contains a few `�` characters. Those are almost
certainly paste artifacts — their messages are far below the split threshold,
so no split occurred. The bug is real regardless, and it lives in the one
function whose entire job is delivering text intact.

Verified by removing the guard and watching the test fail:

```
not ok 4 - splitting never cuts an emoji in half
  error: 'no dangling high surrogate'
```

The test splits 3,000 hammers at five different widths, asserting no
replacement characters, no dangling high surrogate, no orphan low surrogate,
and that the rejoined parts equal the input exactly — nothing lost, nothing
invented.

## A test that had to be rewritten rather than fixed

`"a long answer is split rather than truncated"` forced a split by giving ten
runs a 600-character driver name, relying on the driver being echoed verbatim
into the message. That echo is exactly what this milestone removed, so the test
could not be repaired — its premise was the defect.

It is now `"/runs stays one readable message however absurd the underlying
data"`: ten runs with 600-character drivers and 6,000-character subjects must
produce a single message, under the limit, with no raw driver id in it and no
line over 200 characters. The splitting behaviour it used to cover is tested
directly in `tests/telegram-report.test.ts`, where splitting still applies.
