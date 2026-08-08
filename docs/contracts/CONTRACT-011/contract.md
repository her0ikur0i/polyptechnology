# CONTRACT-011 — Enforced provider roles and DeepSeek-Codex-Claude execution engine

Status: active (descoped to M0-M3 by Amendment 2, 2026-08-09 -- dashboard/
staging/acceptance moved to CONTRACT-012)

## Objective

Make DeepSeek-first technical execution a fail-closed runtime invariant,
attribute accepted artifacts to concrete provider/model attempts, and build a
versioned, owner-adjustable orchestration policy engine with a real,
Docker-verified patch executor -- the engine CONTRACT-012's dashboard will
control, not a dashboard itself.

## Scope

- DeepSeek is mandatory first executor for every programming task; Codex is an
  automatic technical fallback tier after evidenced DeepSeek failure, and
  Claude is the final fallback after evidenced Codex failure (Amendment 1,
  2026-08-09 -- see Amendments).
- Codex retains strategy, decomposition, routing, integration, verification,
  and final-gate duties. A manual, explicit, audited owner override remains
  available for Codex technical execution outside the automatic chain above.
- Concrete requested and provider-resolved models, patch digests, accepted/rejected
  artifacts, changed-line attribution, usage, fallback reasons, and rework are
  durable and visible.
- Versioned policy draft, simulation, validation, approval, activation, rollback,
  concurrency, execution envelope, soft-budget observation, and high emergency
  ceiling controls -- the storage and permission engine only; the owner-facing
  UI for it is CONTRACT-012's `OwnerPolicyService` wiring.
- A real, isolated-Docker-verified patch executor
  (`AiPatchExecutorDriver`/`AiPatchOperationDriver`) wired into the live
  supervisor loop, with a deterministic code-cleanliness gate
  (`format:check`) alongside tests.

## Out of scope

Public production cutover, DNS changes, secret disclosure/rotation, removal of the
emergency cost circuit breaker, anonymous policy mutation, and autonomous role
changes derived from worker prompts.

## Provider and model policy

(Updated by Amendment 1, 2026-08-09 -- see Amendments. `MODEL_POLICY_VERSION
2026-08-09.1` in `src/gateway/model-policy.ts` is the executable source of
truth; this section must be kept in sync with it, not the other way around.)

- Bulk code / complex backend / repair: DeepSeek `deepseek-v4-flash`, then
  `deepseek-v4-pro`, then Codex `gpt-5.6-terra`, then `gpt-5.6-sol`, then
  Claude `claude-sonnet-5` -- cheapest viable tier first, escalating only on
  verified same-task failure evidence at each step.
- Security review: Claude `claude-sonnet-5`, escalating to `claude-opus-4-8`;
  `critical_review` also has a `codex gpt-5.6-sol` escalation route so it is
  never a Claude single point of failure. A provider must never review a task
  it executed as a technical-fallback tier.
- Strategic orchestration: Claude `claude-sonnet-5` by default, escalating to
  `claude-opus-5` only for high-stakes strategic decisions (owner-exchanged
  from Codex under Amendment 1). Codex retains integrator/verifier/final-gate
  duties, which are complementary to orchestration, not the same slot.
- Both requested and resolved identifiers are mandatory; aliases alone fail the
  evidence gate.

## Capability envelope

L0 inspection; L1 contract-owned code/tests/docs and disposable databases; L2
bounded managed provider calls and isolated patch execution. Staging service
activation is authorized only within the existing private access boundary and
must retain rollback. Production, DNS, secret, and irreversible actions remain L3
and require a distinct approval record.

## Milestones

1. M0: contract, baseline usage, role invariants, and evidence design.
2. M1: fail-closed routing with owner-scoped role exchange.
3. M2: DeepSeek patch executor and artifact provenance.
4. M3: versioned policy persistence, simulation, validation, activation, rollback.

**Descoped by Amendment 2 (2026-08-09):** M4-M10 (dashboard/Control API,
usage/attribution views, e2e enforcement tests, independent security review,
staging deployment, owner acceptance, final commit/push) move to
`CONTRACT-012` -- see `docs/contracts/CONTRACT-012/contract.md`. CONTRACT-011
closes with the provider-routing and execution-engine scope actually
delivered (M0-M3): a contract this size stays reviewable and gate-checkable
in one pass, matching the project's own "small contracts, several
milestones" principle rather than one contract spanning routing policy,
patch execution, a full Control API server, staging, and acceptance at once.

## Gates

- A programming task cannot be leased without an initial DeepSeek route.
- Codex technical execution is allowed automatically on durable, *verified*
  DeepSeek failure evidence for the same task, or via a task-scoped owner
  override outside that chain. Claude technical fallback requires durable
  verified failure evidence for *both* DeepSeek and Codex on the same task
  (Amendment 1, 2026-08-09).
- A transport/protocol failure (bad envelope, timeout, empty response) must
  retry the same tier and must never produce verified failure evidence on its
  own; only an isolated patch-verifier rejection may unlock the next tier
  (`src/policy/failure-classification.ts`).
- A new policy version may not leave `draft` for `validated` until every
  registered `(provider, requestedModelId)` route round-trips live through its
  adapter and the isolated patch verifier correctly discriminates a
  golden-pass/golden-fail pair (`scripts/policy-canary.ts`).
- Provider output is never applied outside an isolated patch verifier; accepted
  source changes reference provider attempt and artifact digests.
- Policy mutation requires owner authentication, CSRF, optimistic version fencing,
  validation, approval, activation audit, and deterministic rollback.
- Soft budget never silently reroutes; a high finite emergency ceiling prevents
  runaway cost and remains non-disableable.
- Fresh migrations, locked install, full backend/integration tests, build,
  audit, scope, diff, and secret gates pass with zero skips
  (`TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test`).
- Executor-generated code passes a deterministic format gate
  (`npm run format:check`) before acceptance, not just tests
  (`src/operations/verification-image-policy.ts`).

(Dashboard-control, staging, and owner-acceptance gates move to
`CONTRACT-012` with M4-M10 -- see Amendment 2.)

## Acceptance

- A real managed programming scenario starts with DeepSeek and stores an
  attributable patch; forced verified DeepSeek failure falls back to Codex;
  forced verified Codex failure falls back to Claude; Codex is rejected
  absent verified DeepSeek failure evidence or an explicit owner override.
  Proven end-to-end against a real disposable database and a real Docker
  sandbox, not mocks (`tests/ai-patch-driver-docker.integration.test.ts`,
  `tests/ai-patch-executor-integration.test.ts`).
- The policy engine's full lifecycle (draft/validate/approve/activate/
  rollback/simulate) is proven against a real disposable database
  (`tests/policy-postgres.integration.test.ts`).

(Dashboard-facing acceptance -- owner inspecting/adjusting routes through a
UI, usage/artifact views, private staging access -- moves to `CONTRACT-012`
with M4-M10.)

## Rollback

Activate the preceding immutable policy version and staging release, stop the new
unit if health fails, and restore the pre-migration backup when schema rollback is
required. Provider attempts and audit/provenance records remain immutable.

## Amendments

### Amendment 1 (2026-08-09) — Claude/Codex role exchange and 3-tier technical fallback

Owner-authorized under "Owner may explicitly exchange Codex/Claude strategic
roles" (original Provider and model policy). Recorded here rather than by
silently rewriting history, consistent with this contract's own immutability
posture for provider attempts and provenance.

- Claude is strategic orchestrator (`claude-sonnet-5` default, `claude-opus-5`
  escalation for high-stakes strategic decisions). Codex retains integrator,
  verifier, and final-gate duties -- complementary to orchestration, not the
  same slot, and unaffected by the exchange.
- Technical execution for every programming task class escalates
  deepseek -> codex -> claude, cheapest viable tier first at each stage.
- Codex technical execution is now automatic on verified DeepSeek failure
  evidence for the task (`src/policy/execution-permission.ts`), not only via a
  manual per-task owner override. The manual override remains available for
  cases outside the auto-escalation chain.
- Claude technical fallback now requires verified failure evidence for *both*
  DeepSeek and Codex on the same task -- fallback of the fallback, never a
  shortcut past Codex.
- Anti self-review rule: a provider must never be the reviewer of record for a
  task it executed as a technical-fallback tier. `critical_review` gained a
  non-Claude (`codex`) escalation route so it is never a Claude single point
  of failure, subject to this same rule.
- Token-efficiency principle: default to the cheapest viable model for a role;
  escalate to a stronger/more expensive tier only on verified failure
  evidence, never by default. Applies to executor and orchestrator roles
  alike -- orchestration also has a light/heavy tier, not one fixed model.
- Escalation distinguishes a transport/protocol failure (bad envelope,
  timeout, empty response -- retry the *same* tier, never escalate) from a
  verified patch-verifier rejection (`provider_artifacts.status='rejected'`
  -- the only thing allowed to produce `FailureEvidence{verified:true}` and
  unlock the next tier). See `src/policy/failure-classification.ts`.
- Before a new policy version may leave `draft` for `validated`, every
  `(provider, requestedModelId)` route registered for that version must
  round-trip live through its adapter (`scripts/policy-canary.ts`), and the
  isolated patch verifier must correctly discriminate a golden-pass and a
  golden-fail patch pair.
- `MODEL_POLICY_VERSION` bumped to `2026-08-09.1`.

Live canary run on 2026-08-09 confirmed all 8 routes registered under
`2026-08-09.1` round-trip cleanly: `deepseek-v4-flash`, `deepseek-v4-pro`,
`gpt-5.6-terra`, `gpt-5.6-sol`, `claude-sonnet-5`, `claude-opus-5`,
`claude-haiku-4-5-20251001`, `claude-opus-4-8`. The canary run also confirmed
the root cause of the earlier `m1-deepseek-pro.json` empty-attempt incident:
a `deepseek-v4-pro` thinking-mode call with too tight a `maxOutputTokens`
budget spends the entire budget on reasoning tokens before any answer text,
producing empty `content` and failing `invalid_provider_accounting` -- not an
adapter defect. Production routes already use budgets well above the failure
threshold; the canary script itself needed correcting from 32 to 512 tokens.

### Amendment 2 (2026-08-09) — M2 wired end-to-end, verified with real Docker, code-cleanliness gate added

- `migrations/0009_ai_patch_executor.sql` extends `operation_task_specs` so
  `ExecutableTaskSupervisor` (built in CONTRACT-010) can host a
  self-verifying driver whose correctness isn't knowable before execution --
  `expected_output_sha256` is nullable for the new `ai_patch_executor` driver
  only; `deterministic_sha256`'s original invariant is unchanged and
  DB-enforced. `src/orchestrator/sequence-main.ts` now registers both drivers
  side by side.
- **Real-infrastructure finding:** the first "done" claim for M2 was
  verified only against fake adapters/runners, not a real Docker sandbox.
  Running it for real (`tests/ai-patch-driver-docker.integration.test.ts`)
  surfaced a genuine design bug: `executeWorker()` deliberately refuses any
  workspace containing `.git` (credentials/history must never be reachable
  from inside the sandbox), but the driver was applying the patch via
  `git apply` into the *same* directory then handed to that sandbox. Fixed
  with `src/operations/workspace-copy.ts`
  (`GitIgnoringWorkspaceCopier`) -- the git-apply target and the verification
  sandbox are now always separate directories, the latter populated by a
  `.git`-excluding copy. Confirmed with two real end-to-end tests (real
  `git apply`, real Docker container, no mocks).
- **Code-cleanliness gate** (answers "how do we make sure executor-generated
  code is always clean"): `prettier` added as a devDependency,
  `.prettierrc.json` pins `trailingComma: "all"`, `npm run format` /
  `format:check` added. `src/operations/verification-image-policy.ts`'s
  default verification command is now
  `npm run typecheck && npm run format:check && npm test` -- formatting is a
  deterministic gate like any other, not left to whichever provider produced
  the patch. The sandbox is `--read-only`, so this can only check formatting
  and reject, never auto-fix in place; a rejection escalates to the next
  fallback tier exactly like a failing test. Every generated project must
  carry matching `typecheck`/`format:check` npm scripts -- this repo's own
  `package.json` is the template. (Pre-existing files from earlier,
  already-accepted contracts were deliberately left unformatted rather than
  mass-reformatted outside this contract's ownership -- `format:check` is
  not wired into this repo's own top-level `npm run verify` for that reason,
  only into the sandboxed check chain future generated projects run.)
- `tests/docker-worker.integration.test.ts`'s one standing skip was not a
  bug -- it's gated behind `TEST_WORKER_IMAGE` on purpose (no default Docker
  pull cost in ordinary runs). Supplying a real pinned digest
  (`postgres@sha256:...`, resolved from the image already pulled for the
  disposable database) makes the full suite pass with zero skips:
  `TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test` is the standing
  full-clean-run invocation from here forward.
- `scripts/verify-contract.ts` (the project's own scope/ownership gate,
  pre-dating CONTRACT-011) was run for real against this contract and caught
  a real ownership gap: `package.json`, `package-lock.json`, and
  `.prettierrc.json` were dirty but undeclared, and `migrations/0008_*.sql`'s
  explicit-filename pattern didn't cover the new `0009_*.sql`. File ownership
  below is corrected accordingly.

## File ownership

- `.github/workflows/**`
- `deploy/**`
- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/contracts/CONTRACT-011/**`
- `docs/operations/**`
- `docs/security/**`
- `migrations/0008_provider_role_enforcement.sql`
- `migrations/0009_ai_patch_executor.sql`
- `scripts/**`
- `src/dashboard/**`
- `src/gateway/**`
- `src/orchestrator/**`
- `src/operations/**`
- `src/policy/**`
- `src/worker/**`
- `tests/**`
- `package.json`
- `package-lock.json`
- `.prettierrc.json`
- `docs/contracts/CONTRACT-012/contract.md`

(The last entry is a narrow exception: drafting the handoff contract's
charter is part of closing this one out. It does not extend to
CONTRACT-012's own evidence or implementation files.)
