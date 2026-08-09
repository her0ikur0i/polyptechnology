# M5 — Narrative brief → proposal → owner approval, in the UI

Status: done, 2026-08-09.

## Wiring, not building: `OrchestratorService` was already there

`src/orchestrator/service.ts`'s `submitProposal`/`requestOwnerReview`/
`approve`/`handoff` cycle has existed since CONTRACT-006 -- built, tested
(`tests/orchestrator.test.ts`), and never reachable from any route except
the one-shot `POST /api/v1/orchestrator/proposals` (title+objective ->
conversation+proposal in a single call, unrelated to an actual
conversation's message history). M5's job was making it reachable from a
real, already-populated conversation, and closing one real gap:
`OrchestratorService` had `approve`/`handoff` but no `reject` -- added a
two-line `reject()` mirroring the existing `transitionProposal(...,
"rejected")` path the store already supported.

## A real design decision: the narrative brief is the transcript, not a summary

"Narrative brief" could mean an AI-generated summary of the conversation
(another `AiGateway` call) or the raw transcript itself. Chose the
transcript: `**owner**: ...` / `**assistant**: ...` blocks, joined,
excluding `classification === "secret"` messages (same rule M2's addendum
fix applies -- currently inert, same reasoning). This keeps M5 a
deterministic, mechanical wiring milestone rather than adding a second AI
call whose output M6 would immediately need to parse back apart to derive
a blueprint anyway. Documented here as a real, made decision, not left
implicit.

## Approve and handoff are one action, not two

There is no owner decision between `approved` and `handed_off` --
`handoff()` only freezes and returns the candidate for M6's translation
step. `OwnerCommandService.approveProposal()` calls `approve()` then
`handoff()` in sequence, so a single "Approve" click in the UI does both,
rather than making the owner press two buttons for what is really one
decision. The approval itself needs no separate Telegram/approval-request
round trip -- consistent with how every other owner-authenticated action
in this system (policy activation, rollback, project creation) is
authorized by `requireOwner` + CSRF alone, not a scoped approval record;
`approvalId` is a deterministic id representing "the owner approved this
in an authenticated session," matching that existing precedent rather than
inventing a new authorization tier for this one action.

## What was built

- `OwnerCommandService.draftProposal()`, `.approveProposal()`,
  `.rejectProposal()` (`src/operations/owner-commands.ts`).
- Four Control API routes: `POST /api/v1/orchestrator/conversations/:id/proposals`,
  `POST /api/v1/orchestrator/proposals/:id/approve`,
  `POST /api/v1/orchestrator/proposals/:id/reject`,
  `GET /api/v1/orchestrator/proposals/:id`.
- A "Proposal" panel in `ConversationWorkspacePage`: draft button (disabled
  until at least one message exists), the compiled candidate rendered
  read-only, Approve/Reject buttons while `owner_review`, and the
  approval id once `handed_off`.

## Verified live, not just by tests

Booted the real dev server and ran the exact sequence the UI performs:
drafting with zero messages correctly rejected
(`"conversation has no messages to draft a proposal from"`); sending a
message then drafting produced a real `owner_review` proposal with the
compiled transcript; fetching it by id; approving it in one call and
receiving a real `approvalId` plus the frozen candidate; a second
conversation's proposal rejected, confirmed terminal (a stale-version
approve attempt against it correctly returned `"invalid proposal
transition"`); a missing-CSRF draft attempt rejected with `403`.

This live pass re-hit the same shared-disposable-database landmine
documented in earlier milestones' evidence -- the reply tasks queued by
sending messages during live testing were never consumed and would have
collided with the next test run's `ExecutableTaskSupervisor.runOne()`.
Fixed the same way as before: recreated the disposable database fresh
before running the real test suite, and the new formal tests explicitly
cancel every reply task they queue.

## Test evidence

2 new tests in `tests/control-api.integration.test.ts`: the full
draft -> fetch -> approve -> handoff path (including the empty-conversation
rejection), and the reject path plus stale-version and missing-CSRF
negative cases.

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 173
# pass 173
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run dashboard:build`,
`npm run typecheck`, `npm run format:check`, and
`scripts/verify-contract.ts CONTRACT-014` all pass.
