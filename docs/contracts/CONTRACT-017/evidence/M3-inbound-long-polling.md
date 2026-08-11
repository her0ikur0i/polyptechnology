# M3 — Inbound long polling

Date: 2026-08-10. Status: **done**.

## Why polling rather than a webhook

A Telegram webhook needs a publicly reachable HTTPS endpoint. This deployment is
loopback-only, and public exposure is deliberately deferred to CONTRACT-022.
`getUpdates` is an **outbound** call, so inbound Telegram works with no inbound
port, no hostname, no DNS change and no new trust boundary.

The two transports are mutually exclusive — Telegram refuses `getUpdates` while
a webhook is registered — so this also means never calling `setWebhook`. The
existing webhook route is left untouched for a future deployment that does have
public ingress.

## The offset has to be durable

`getUpdates` is an at-least-once queue: it returns everything past an offset and
only discards what the caller acknowledges by asking for a higher one. Keep that
offset in memory and a restart either replays everything already handled or
skips whatever arrived while the process was down.

Migration `0015` adds `update_offset` to `telegram_settings`, which is already
the singleton row for Telegram state. A dedicated table for one integer would be
more structure than the fact deserves.

Two details that matter more than they look:

- **`GREATEST`, not assignment.** Two pollers briefly overlapping during a
  restart would otherwise let the slower one rewind the queue and replay
  everything the faster one had already handled.
- **Default 0, meaning "take whatever is queued".** A fresh install should
  receive an approval that was sent while the service was being deployed, not
  discard it.

## Identity is checked before content is read

The channel is the credential here, so `authorized()` runs before anything in
the update is interpreted. An update from an unknown chat or user is counted and
skipped — it never reaches the handler, which is where content becomes meaning.

`originOf()` exists because **a message and a button tap carry identity in
different places**: a message has `message.chat` and `message.from`, while a
callback has `callback_query.message.chat` and `callback_query.from`. Reading
the wrong one on a callback would authorise the chat owner instead of the person
who actually tapped. Both shapes are tested, including the case where they
disagree.

Telegram sends ids as numbers while configuration holds them as strings, so
comparison is on strings — also tested, because a silent type mismatch here
would fail open or closed depending on nothing but luck.

## Failure choices

- **A failing update does not block the queue behind it.** The offset advances
  anyway. Retrying forever is how one malformed message stops every approval
  that comes after it. This is safe in the direction that matters: approval
  tokens are single-use, so a lost handling never authorises anything twice.
- **`ok: false` is a failure, not an empty queue.** Treating it as "nothing
  waiting" would hide a broken bot token behind a permanently quiet channel —
  the worst failure mode available to a notification system.
- **Backoff is exponential and capped** at 60 s by default. A Telegram outage
  degrades into quiet retrying, never a hot loop against an API that is already
  struggling. It resets the moment Telegram answers again.
- **An aborted signal stops the poll without calling Telegram at all**, so
  shutdown does not leave a 25-second request hanging.

## Verification

`tests/telegram-poller.test.ts` — 11 tests covering origin extraction from both
update shapes, numeric-vs-string ids, refusal by chat and by user, offset commit
and the "one past the last handled id" request, monotonic offsets, one failing
update not blocking the rest, exponential backoff with a cap, backoff reset,
`ok: false` treated as failure, and an aborted signal short-circuiting.

`tests/telegram-offset.integration.test.ts` — 3 tests against real Postgres,
because durability is the claim: the offset survives a new store instance, a
lower offset cannot rewind it, and negative or fractional values clamp rather
than throw.

Full backend suite, standing zero-skip invocation:

```
# tests 257
# pass 257
# fail 0
# skipped 0
```

257 = 243 after the execution-enabling work + 14 new. `typecheck` clean,
`format:check` clean repository-wide.

## Not yet wired into the supervisor

The poller is built and tested but not yet running in `sequence-main.ts`, and no
handler is attached. That is M4 (approvals), M5 (conversation) and M6 (the
closed command set) — attaching a poller with nothing to hand updates to would
create a loop that consumes the queue and discards it, which is worse than not
polling at all.
