# M3 — One ledger entry per attempt

Date: 2026-08-11. Status: **done**.

## Why every conversation retry died in 25 milliseconds

The gateway idempotency key for a reply is `conversation-reply-<taskId>`,
written into `operation_task_specs.input` — a row that is **immutable by
trigger**. So the key was necessarily identical on attempt 3 and attempt 1,
while the request hash covers the transcript, which grows between attempts.

`PostgresAttemptLedger.reserve()` looks the key up, finds the first attempt's
row, compares `requestHash`, and throws:

```
idempotency intent mismatch
```

before reserving budget and before calling a provider. That is the 25 ms with
no ledger row seen on staging in CONTRACT-017: a retry was futile for exactly
the conversations most likely to need one, because a thread that has moved on
is the normal case.

The ledger was right. The key was wrong.

## The fix, and the two things it must not break

Per the owner's M0 decision, each attempt now gets its own ledger entry. The
supervisor knows which attempt it is running; it passes that down through a new
optional `OperationContext`, and the driver derives:

```
attempt 1  →  conversation-reply-<taskId>
attempt 3  →  conversation-reply-<taskId>#3
```

**Attempt 1 keeps the original key.** Nothing already in the ledger is
orphaned, and a genuinely duplicated delivery of a first attempt still
deduplicates — which is what idempotency is for.

**The appended message id does not vary by attempt.** It stays
`deterministicUuid("conversation-reply:" + stored.idempotencyKey)`, as does the
`appendMessage` idempotency key. Conversation-level identity is what stops a
retry adding a second assistant reply to the thread; only the _ledger_ identity
is per-attempt. The test asserts both halves together, because getting one
right and the other wrong is the plausible mistake.

`OperationContext` is optional, so every other driver compiles and behaves
identically, and a driver called without it behaves as attempt one.

## Tests

`tests/conversation-resume.test.ts`, 9 passing. The two added here:

- attempt 1 and attempt 3 produce different ledger keys and the _same_ appended
  message id
- a driver called with no context behaves as attempt one

Full suite: **370 tests, 370 passing, 0 skipped**.
