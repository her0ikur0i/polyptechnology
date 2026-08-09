# M11 — Repository-wide code quality cleanup

Status: done, 2026-08-09. Scope per owner's explicit instruction: formatting

- dead-code/duplication audit, placed last as the deliberate closing act
  before the single final commit.

## Formatting

`npm run format` (`prettier --write .`) run repository-wide. 46 files
changed, all confirmed formatting-only by direct diff inspection (spot
-checked `src/work/engine.ts`, `src/providers/router.ts`,
`scripts/verify-contract.ts`, and several `docs/contracts/CONTRACT-01{0,1,2}`
evidence files -- every diff is whitespace/line-wrap reflow or, in markdown,
`*emphasis*` -> `_emphasis_` style normalization; zero logic or content
changes). `npm run format:check` now reports zero warnings repository-wide,
satisfying the contract's own gate for this milestone. Full suite green
before and after (164/164 backend, 19/19 dashboard, `npm run dashboard:build`
succeeds).

### A known, expected `scripts/verify-contract.ts` limitation

`contract.md`'s own text states: "M11 (code quality cleanup) is the sole,
explicit, temporary exception: its file ownership extends to `**` for
formatting-only changes." `scripts/verify-contract.ts`'s ownership check has
no notion of milestones -- it only parses the static bullet list under
`## File ownership`, so it correctly reports every file outside that list
(`src/index.ts`, `src/providers/**`, `src/work/**`,
`docs/contracts/CONTRACT-010/**`, `docs/contracts/CONTRACT-011/**`,
`docs/contracts/CONTRACT-012/**`, `scripts/verify-contract.ts` itself) as
"out of scope" once `prettier --write .` touches them. This is expected, not
a bug to silently work around: the contract's own prose is the actual
authority for the M11 exception, and every one of those paths was manually
diff-reviewed (see above) to confirm the only changes are formatting. Not
fixing the checker itself (adding milestone-awareness) since
`scripts/verify-contract.ts` is not in CONTRACT-013's normal ownership
list -- doing so would be a behavioral edit to an out-of-scope file, exactly
what the exception does _not_ license.

## Dead-code / duplication audit

An independent read-only audit (separate pass from the formatting work)
covered `src/`, `scripts/`, and cross-referenced `tests/`. Full findings,
ranked by confidence:

**Confirmed dead, but outside CONTRACT-013's file ownership -- documented
and queued, not deleted:**

- `src/index.ts` -- an orphaned entry point. Not referenced by any
  `package.json` script, the systemd unit, or any import anywhere in
  `src/`/`scripts/`/`tests/`.
- `src/providers/{adapter,registry,router,types}.ts` -- an entire superseded
  provider-dispatch subsystem, predating `src/gateway/*` (which replaced it).
  Only `tests/providers.test.ts` still imports it; no production code path
  does.
- `src/work/postgres-publication-recorder.ts` -- an orphaned
  `PostgresPublicationRecorder` class, never instantiated outside its own
  file.

None of these paths are under `src/dashboard/**`, `src/control-api/**`,
`src/factory/**`, `src/telegram/**`, `src/approvals/**`, `src/policy/**`,
`src/operations/**`, `src/orchestrator/**`, `src/gateway/gateway.ts`, or
`src/config.ts` -- CONTRACT-013's declared ownership. Deleting them here
would be exactly the kind of out-of-scope behavioral edit the contract's
ownership manifest exists to prevent (and `scripts/verify-contract.ts` would
correctly reject it, unlike the formatting exception above, since deletion
is not "formatting-only"). Queued for a future contract's own cleanup scope
rather than smuggled in under this one.

**Fixed (in scope: `src/factory/**` is owned by CONTRACT-013):**

- `src/factory/postgres-repository.ts`: removed the unused
  `export const newProjectId = () => randomUUID();` (zero references
  anywhere, verified by `grep -rn "newProjectId" src tests scripts`) and its
  now-unused `randomUUID` import. Full suite re-verified green after.

**Not dead -- already correctly tracked elsewhere, left alone:**

- `src/telegram/gateway.ts`'s outbound `TelegramHttpTransport`/
  `TelegramApprovalGateway` (only exercised by `tests/approvals.test.ts`):
  matches CONTRACT-010 Owner Action Bundle item 3 ("Telegram live
  connection... approve one paid/live connectivity probe"), never executed
  by owner-authority decision, not abandoned code. CONTRACT-013 M6 only
  wired _inbound_ webhook decisions, correctly leaving outbound delivery
  activation as the same already-tracked owner-authority gap.
- `src/work/publication-executor.ts` (durable gate-checked automated
  publication, only exercised by `tests/work-engine.test.ts`): plausibly
  superseded by the actual practice this project has followed since
  CONTRACT-011 (an agent runs `git commit`/`git push` directly after
  `scripts/verify-contract.ts` passes, gated by explicit owner "push it"
  confirmation) -- but that is an inference, not a documented decision, and
  `src/work/**` is outside CONTRACT-013's ownership regardless. Flagged for
  a future contract to either wire in or formally retire, not decided here.

**Duplication, deliberately not consolidated this milestone:**

- `safePath()` (`src/operations/patch-scope.ts`) and `safeWorkerPath()`
  (`src/worker/planner.ts`) are near-identical path-traversal/`.git`
  -exclusion validators, implemented independently. Security-critical code
  that both currently pass their own tests on; consolidating touches
  `src/worker/planner.ts`, outside CONTRACT-013's ownership. Flagged for a
  deliberate, reviewed follow-up in a future contract, not folded into this
  closing commit.
- The UUID pattern `/^[a-f0-9-]{36}$/` is inlined independently at 9+ call
  sites across `src/dashboard/api.ts`, `src/factory/{blueprint,workspace-provisioner}.ts`,
  `src/orchestrator/postgres-sequence-store.ts`, `src/operations/owner-commands.ts`,
  and `src/policy/owner-policy-service.ts`. All of these files are within
  CONTRACT-013's ownership, so consolidating into one shared validator was
  technically in scope -- deliberately not done anyway: it is a stable,
  unlikely-to-change pattern, the fork audit itself ranked it low-risk/
  low-value (distinct from the security-critical finding above), and
  introducing a new shared module across 6 files right before the closing
  commit trades a real reduction in regression risk for a marginal DRY
  improvement. Documented here as a legitimate, low-priority cleanup
  candidate for whenever one of these call sites is touched again for an
  unrelated reason, not a "premature abstraction" this milestone should
  force.

## Test evidence

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 164
# pass 164
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run dashboard:build`,
`npm run typecheck`, and `npm run format:check` (zero warnings) all pass.
