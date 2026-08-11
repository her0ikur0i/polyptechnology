# M1 — Migration and the session store

Date: 2026-08-11. Status: **done**.

## What the survey changed about this contract

Before writing anything, the plumbing was traced end to end. The Claude CLI
already returns `session_id`, `completionFrom()` already sets it as
`providerRequestId`, and the ledger already persists it on
`ai_gateway_attempts.provider_request_id`.

**Capture was never missing.** The id has been arriving and being stored on
every attempt this system has ever made. What is missing is holding it against
the _conversation_ and handing it back on the next turn. That narrows M2
considerably and is worth recording, because the contract was drafted assuming
capture had to be built.

## Migration 0016

`conversation_provider_sessions (conversation_id, provider_id, session_id,
last_used_at, created_at)`, primary key on the first two.

A side table rather than a column on `conversations`, per the owner's M0
decision: the execution chain `deepseek → codex → claude` means a conversation
can hold a live session with one provider and a dead one with another, and the
single-column design assumes that never happens.

Two constraints earn their place:

- `provider_id` is checked against the same three providers the rest of the
  system routes to, so a typo fails at write time rather than silently creating
  a session nothing will ever look up.
- `session_id` is length-bounded, because it is provider-supplied text that
  ends up in a command line.

`last_used_at` is written on every use, not only on insert. An expiry sweep —
which this contract does not build — would key off it, and a column meaning
"first exchange" would be useless for that.

Applied to the test database. Staging gets it at M5 with the redeploy.

## The store, and why it forgives

`PostgresProviderSessionStore` is a plain read/upsert/delete. The interesting
part is `ForgivingProviderSessionStore`, which wraps any store so no failure
inside it can reach a caller.

Session lookup sits directly in the path of answering the owner. **A miss is
ordinary and must stay cheap**: an absent row, a database hiccup, a provider
that reports no session — each means the turn replays the transcript, which is
exactly what every turn did before this table existed. The degraded behaviour
is the old behaviour, so nothing here is allowed to cost a reply.

That is enforced in one wrapper rather than trusted to every call site
remembering a `try`/`catch`. Failures are logged, never silently swallowed:
an empty catch is what hid the approval-button bug in CONTRACT-017 and the
supervisor's discarded error in CONTRACT-017B, twice in two contracts.

## Tests

`tests/provider-sessions.integration.test.ts`, 7 passing against the real
schema:

- a session is remembered and found again
- one conversation holds a session per provider — the reason this is a table
- re-remembering replaces rather than colliding on the primary key
- `last_used_at` moves forward even when the id is unchanged
- forgetting sends the next turn back to replay
- the schema refuses an unknown provider
- a store that throws on every method degrades to "no session" and logs three
  distinct events rather than failing the reply
