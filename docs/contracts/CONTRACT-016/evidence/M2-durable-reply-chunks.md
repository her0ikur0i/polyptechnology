# M2 — Durable reply chunks

Date: 2026-08-10. Status: **done**.

## Why these are durable at all

`ConversationReplyDriver` runs inside `polyp-sequence.service`. The SSE
connection that will carry tokens to the browser is held by the Control API, a
different process. In-memory buffering cannot cross that boundary, so fragments
go through Postgres.

Migration `0014_reply_streaming.sql` adds `conversation_reply_chunks`
(`task_id`, `conversation_id`, `ordinal`, `fragment`, `created_at`), with
`UNIQUE(task_id, ordinal)`, an index on `(task_id, ordinal)` for the SSE
route's only query shape, and one on `created_at` for retention.

## These rows are progress, not record

Stated in the migration itself so it cannot be missed by someone reading only
the schema: **nothing may rebuild a message by concatenating chunks.** M1
established that `ManagedCompletion.content` is the single source of truth; a
stream that dies mid-answer therefore leaves rows nobody promotes, and the
conversation is unharmed.

Two schema choices follow from that:

- **No foreign key to `tasks(id)`.** A chunk outliving its task row is harmless
  progress debris, whereas a cascade could delete the evidence of a live stream
  while a client is mid-read. The `conversations` reference _is_ real, because a
  chunk that outlives its conversation has nowhere to be displayed.
- **`clear()` is deliberately not in the same transaction as `appendMessage()`.**
  A failure to clean up progress debris must never be able to roll back a
  completed answer.

## Ordinals come from the writer

`append()` takes the ordinal rather than deriving it with a `MAX()` subquery.
The writer is a single sequential consumer of one provider stream and already
knows the order; computing it in SQL would invite two concurrent writers to
agree on the same number, and `UNIQUE(task_id, ordinal)` would then turn a
harmless race into a failed reply.

The unique constraint is still load-bearing in the other direction: a driver
retried after a transient failure replays an ordinal, and `ON CONFLICT DO
NOTHING` means the reader never sees a doubled fragment.

## Degradation choices

- **An oversized fragment is truncated at 65,536 bytes, not rejected.** The real
  answer arrives through the completion envelope, so a provider emitting one
  enormous fragment should cost the owner a truncated progress view rather than
  a failed reply.
- **An empty fragment is not stored at all**, so a provider emitting keepalives
  cannot fill the table with rows carrying no information.

## Verification

`tests/reply-chunks.integration.test.ts` — 6 tests: ordered read-back;
resume-after-ordinal (the reason ordinals exist — a reconnecting client
continues rather than replaying the answer); a replayed ordinal ignored rather
than doubled; per-task scoping; oversized fragment truncated; empty fragment
dropped; and `clear()` removing only the finished task's progress while a live
stream's rows survive.

One test fixture was wrong on first run and was corrected, not the schema: it
inserted a `state` column into `conversations` that does not exist. The real
table has `id, project_id, title, version, created_at, archived_at`.

Full backend suite, standing zero-skip invocation:

```
# tests 205
# pass 205
# fail 0
# skipped 0
```

205 = 199 after M1 + 6 new. `npm run typecheck` clean. `npm run format:check`
clean repository-wide.

**Migration state:** `0014` is applied to the disposable test database
(`polyp-contract011-pg`, port 55433). It is **not** yet applied to
`polyp-staging-pg` — that happens at M11 with the staging redeploy, matching how
CONTRACT-014 M10 applied `0011`–`0013`.
