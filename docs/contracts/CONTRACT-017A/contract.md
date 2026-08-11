# CONTRACT-017A — Session-based conversation continuity

## Objective

Stop replaying the entire transcript into every conversation turn.

Today each reply re-sends the whole thread as one text blob. Cost grows with
thread length, prompt-cache reads already run to six figures of tokens per
turn, and a long enough thread will eventually be refused outright by the
provider. The CLI supports resuming a session it already holds; this system
has never used it.

Two defects inherited from CONTRACT-017 are consequences of that design, and
this contract owns both:

- **A `conversation_reply` retry can never succeed once the conversation has
  advanced.** The gateway's idempotency key is per-_task_ and outlives every
  attempt, while the request hash covers the transcript, which grows. The retry
  finds the first attempt's ledger row, sees a different hash, and throws
  `idempotency intent mismatch` before reserving budget or calling a provider.
  Retry is therefore futile for exactly the tasks most likely to need it.
- **`SYSTEM_PROMPT_FINGERPRINT` is a workaround for whole-transcript replay.**
  It starts a fresh thread whenever the prompt changes, because a stale
  transcript once made the assistant recant a correct answer nine seconds after
  giving it. That fixes one symptom by discarding the owner's history.

## What is already true, and narrows this contract

The Claude CLI already returns `session_id`, and this system already stores it:
`completionFrom()` sets it as `providerRequestId`, and the ledger persists it on
`ai_gateway_attempts.provider_request_id`. **Capture is done.** What is missing
is storing it against the conversation, and passing it back on the next turn.

## M0 — Owner confirmation

Answered 2026-08-11, in the batch taken before CONTRACT-017B started, so this
contract runs without pausing. Recorded in
`docs/contracts/CONTRACT-017B/evidence/M0-owner-confirmation.md`:

1. **Session storage: a side table** `conversation_provider_sessions`, keyed by
   `(conversation_id, provider_id)`. A conversation can hold a live Claude
   session and a dead DeepSeek one at the same time, and the escalation chain
   means the "one provider per conversation" assumption behind a single column
   will not hold.
2. **Retry identity: each attempt is its own ledger entry**, keyed per
   `(task, attempt)`. A retry becomes a new reservation and a new audit row,
   which is what actually happened. Rewriting the first attempt's request hash
   was declined for overwriting the record the ledger exists to keep.

Standing rules from the same batch apply: security review before the push,
README updated at close, commits authored `heroikuroi`, and a successful push
rolls straight into CONTRACT-018.

## Scope

- Migration `0016`: `conversation_provider_sessions (conversation_id,
provider_id, session_id, last_used_at)`, primary key on the first two.
- A store that reads and upserts it, alongside the existing conversation stores.
- `GatewayRequest.resumeSessionId`, threaded to the adapter, which passes
  `--resume` to the CLI.
- `ConversationReplyDriver` sends **the new turn only** when a session exists,
  and the full transcript when one does not.
- Ledger idempotency keyed per attempt, retiring `idempotency intent mismatch`
  as a retry outcome.
- Retire `SYSTEM_PROMPT_FINGERPRINT` from the conversation key.
- Honest failure modes: an expired session, a lost id, or a provider that
  reports no session at all each fall back to replay rather than losing a reply.

## Out of scope

- Any dashboard work. CONTRACT-018 owns the chat window.
- Summarisation or truncation of long threads. Sessions remove the need for
  now; if a session-resumed thread ever hits a limit, that is its own contract.
- Releasing the $0.60 held by three `outcome_unknown` ledger rows.

## Milestones

0. M0: owner confirmation, recorded above.
1. M1: migration and the session store.
2. M2: resume threaded from the driver through the gateway to the CLI.
3. M3: per-attempt ledger identity, retiring the mismatch failure.
4. M4: retire the prompt fingerprint; fall back to replay honestly.
5. M5: live drill proving a second turn costs less than the first, README,
   security review, close.

## Gates

- A second turn in the same conversation sends fewer input tokens than the
  first, measured from the ledger, not asserted.
- Killing the stored session id mid-thread produces a correct reply, by
  falling back to replay — proven by deleting the row and asking again.
- A retried `conversation_reply` reaches the provider instead of throwing
  `idempotency intent mismatch`.
- Changing the system prompt does not silently inherit a contradicting
  transcript.
- Full suite, dashboard suite, `typecheck`, `format:check`, `npm audit`,
  `verify-contract.ts`, and `resume-checkpoint.ts --check` pass with zero skips.
- `/security-review` runs clean, or its findings are fixed before the push.

## Acceptance

- A long conversation costs roughly what a short one costs per turn.
- A failed reply can be retried and succeed.
- The owner keeps their thread across a prompt change.

## Rollback

Revert the commit. The migration is additive and forward-only; an empty
`conversation_provider_sessions` makes every turn fall back to replay, which is
exactly today's behaviour.

## File ownership

- `docs/contracts/CONTRACT-017A/**`
- `docs/product/**`
- `docs/RESUME.md`
- `README.md`
- `CLAUDE.md`
- `migrations/**`
- `src/gateway/**`
- `src/operations/**`
- `src/orchestrator/**`
- `src/telegram/**`
- `scripts/**`
- `tests/**`
