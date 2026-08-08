# M3 — Versioned policy persistence, simulation, validation, activation, rollback

Status: done for the core lifecycle; canary-gated validation added 2026-08-09.

## What changed

- `migrations/0008_provider_role_enforcement.sql`: `orchestration_policies`
  (draft -> validated -> approved -> active -> superseded, lifecycle enforced
  by CHECK constraints and a unique-active-per-key index), `policy_events`
  (immutable append-only audit trail), `task_role_overrides`,
  `provider_artifacts`. Applied clean to a fresh disposable Postgres
  (`polyp-contract011-pg`); columns confirmed to match
  `src/policy/postgres-policy-store.ts` exactly (`state`, `creator_id`,
  `validator_id`, `approver_id`, `activator_id` -- not the `status`/
  `created_by` naming an earlier Claude-authored draft proposed; the two
  designs diverged and were reconciled correctly).
- `src/policy/{types,validate-policy,execution-permission,simulate-route,
  postgres-policy-store}.ts`: the policy engine itself.
- `src/policy/owner-policy-service.ts` (new, 2026-08-09): the command surface
  (`createDraft`/`validateDraft`/`approve`/`activate`/`rollback`/`simulate`/
  `createCodexOverride`) that a future dashboard (M4) will call. The prior
  session generated this file's content but never wrote it to disk, and its
  draft imported a module (`./simulate-programming-route.js`) and called
  store methods (`getActive`, `findActiveOverride`) that do not exist in this
  repo. Fixed: import corrected to `./simulate-route.js`, `getActive` ->
  `active`, and `findActiveOverride` honestly stubbed to `undefined` with a
  note -- `task_role_overrides` has no read-path on `PostgresPolicyStore` yet,
  so `createCodexOverride` is not wired to storage either. Both are real gaps
  for whoever picks up M4, not silently faked.
- `scripts/policy-canary.ts` (new, 2026-08-09): live synchronization
  pre-flight across every `(provider, requestedModelId)` pair in the active
  `MODEL_POLICY_VERSION`, intended to gate `draft -> validated` before a
  policy version is trusted. Not yet wired into
  `PostgresPolicyStore.validate()` itself -- currently a standalone script the
  owner/orchestrator runs by hand before approving a new policy version.

## Test evidence

`tests/policy-permission.test.ts`, `tests/policy-routing.test.ts`,
`tests/policy-validator.test.ts`, `tests/policy-postgres.integration.test.ts`
all pass against the fresh disposable DB (see M1 evidence for the full-suite
run: 97 pass / 0 fail / 1 unrelated skip).

## Known remaining gap

`owner-policy-service.ts`'s override read/write path and the canary's wiring
into the `validated` transition are both open -- listed as concrete next steps
in `docs/RESUME.md`, not silently deferred.
