# M2 — Assistant replies, auto-routed through AiGateway

Status: done, 2026-08-09.

## Architecture decision: replies are queued tasks, never a synchronous call inside the HTTP request

`OwnerCommandService.sendMessage()` (M1) appends the owner's message and
returns immediately -- it does not call `AiGateway` itself. Sending a
message additionally **queues** a `conversation_reply` task
(`src/orchestrator/reply-task.ts`'s `queueConversationReply()`), the same
`tasks`/`operation_task_specs` pattern `createGenerationTask` (M5) already
established for code generation. A background supervisor consumes it later
and appends the assistant's response.

This was a deliberate choice, not the only option: a synchronous call
inside the Express route handler would be simpler to wire, but would
contradict everything CONTRACT-011-013 already established --
provider calls are costly, potentially slow, and belong in the queued
-task + supervisor pattern, never blocking an HTTP response. It also
matches the owner's own confirmed decision for model selection ("stays
automatic, owner just sees status") -- "status" implies an async,
observable state, not an instant reply. Consequence: the Control API
process (`polyp-control-api.service`, already running on the M9 staging
instance) still never makes a real provider call itself, unchanged from
every prior contract's design -- only `polyp-sequence.service` (not
running on staging, per CONTRACT-013 M9 decision 4, since it needs real
provider credentials) can actually execute a reply.

## What was built

- **Migration `0011_conversation_reply.sql`**: adds `'conversation_reply'`
  to `operation_task_specs`'s driver check constraint (same pattern
  `0009_ai_patch_executor.sql` used for `ai_patch_executor`), and broadens
  the "hash absent for self-verifying drivers" constraint from naming
  `ai_patch_executor` specifically to "anything but `deterministic_sha256`"
  -- `conversation_reply` is self-verifying the same way.
- **`ConversationReplyDriver`** (`src/operations/conversation-reply-driver.ts`):
  implements `OperationDriver`. Fetches the conversation's message history,
  maps `owner`/`assistant`/`system` roles to the gateway's `user`/
  `assistant`/`system` roles, calls `AiGateway.execute()` with
  `taskClass: "orchestration"` (the pre-existing Claude-first task class --
  `claude-sonnet-5` primary, `claude-opus-5` escalation -- reused as-is, no
  new task class needed, and deliberately _not_ the DeepSeek -> Codex ->
  Claude programming-escalation chain, which is for code generation).
  Appends the response as a real `role: "assistant"` message and returns
  `{ verified: true }` -- self-verifying, since no external verification
  step is meaningful for a conversational reply the way Docker-sandbox
  verification is for a code patch.
- A system prompt embedded in the driver keeps ADR-0002's authority
  boundary in the assistant's own instructions, not just enforced
  elsewhere: "never claim an action has been taken... only the owner's
  later, explicit approval of a proposal can authorize anything."
- **`queueConversationReply()`** (`src/orchestrator/reply-task.ts`): mirrors
  `generation-task.ts` exactly -- creates a `factory_contracts`/
  `milestones`/`ai_budget_accounts` triple (idempotent inserts), scoped
  **per conversation** rather than per project (a conversation can
  accumulate real spend before any project blueprint, let alone a
  generation contract, is real), then submits and queues the task.
  Deliberately bounded separately from code-generation budget (4,000
  output tokens / $0.20 per reply vs. 8,000 tokens / $0.50 for a code
  patch) so one long conversation can't silently consume the same
  envelope as real code generation.
- **`POST /api/v1/orchestrator/conversations/:id/messages`** now queues the
  reply and returns `{ message, replyTaskId }` instead of just the owner's
  message (M1's tests updated for the new shape).
- **`GET /api/v1/orchestrator/reply-tasks/:taskId`** (new route): status
  polling for the UI (M4) to show "assistant is thinking" until the task
  reaches a terminal state.
- Wired into `sequence-main.ts`'s driver map alongside `ai_patch_executor`
  -- the same supervisor process runs both.

## Test evidence

`tests/conversation-reply.integration.test.ts` (new, 1 test): a **real**
owner message, queued for real, picked up by a **real**
`ExecutableTaskSupervisor.runOne()`, routed through a **real** `AiGateway`
(fake Claude adapter, not mocked at the gateway level), and a real
assistant message appended and verified present with the correct ordinal
and content -- the same end-to-end rigor `generation-pipeline.integration.test.ts`
established for code patches, applied to conversation replies.

`tests/control-api.integration.test.ts`'s M1 message-round-trip test
updated for the new response shape, extended to assert the queued reply
task is reachable via the new status route and is `"queued"` (no
supervisor runs against the disposable test database in that test) --
and now explicitly cancels the queued task afterward, since
`ExecutableTaskSupervisor.runOne()`'s eligible-task query has no per-test
scoping (the same shared-database landmine CONTRACT-013 M5 evidence
already documented for the `/generate` route's own test).

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 169
# pass 169
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run dashboard:build`,
`npm run typecheck`, `npm run format:check`, and
`scripts/verify-contract.ts CONTRACT-014` all pass.

## Addendum (found while starting M5, fixed in place)

`ConversationReplyDriver` built its `messages` array independently of
`src/orchestrator/context.ts`'s `compileContext()` -- the existing,
CONTRACT-006-built function that already excludes `classification ===
"secret"` messages from anything sent to a provider. The driver had no
equivalent check, so a hypothetical future secret-classified message would
have been sent to the assistant unfiltered. Currently inert (nothing in
the API can produce a `"secret"`-classified message today --
`OwnerCommandService.sendMessage()` always writes `"internal"`), but a
real correctness gap in shipped code, not a hypothetical -- fixed with the
same exclusion rule `compileContext()` already enforces, rather than
switching the driver to call `compileContext()` itself (which also handles
attachments and byte-budget truncation, out of scope for this narrow fix).

New regression test in `tests/conversation-reply.integration.test.ts`:
a secret-classified message is inserted directly via the store (bypassing
the API, since nothing else can produce one), and a `CapturingFakeClaude`
adapter proves the real gateway call driven by the real supervisor never
receives it while still receiving the legitimate owner message. Full
suite re-verified green: 171/171 (this fix added no new milestone-visible
scope, just a test file addition -- the count moved because M5 had not
yet contributed tests when this addendum was written).
