# Resume checkpoint

## Active objective

`CONTRACT-011` is **committed and pushed** (`a564bf8`, 2026-08-09, `main` on
`origin`, owner-approved), scoped to M0-M3 (Amendment 2). `CONTRACT-012` is
scoped to **M4 only** (Amendment 1, 2026-08-09) -- Control API server + owner
policy UI foundation, done, not yet committed. Everything after M4, plus
every concrete gap found while building and reviewing it, is queued as
`CONTRACT-013` (`docs/contracts/CONTRACT-013/contract.md`, not started).
**The next action in a fresh session is CONTRACT-012's commit/push
checkpoint (M4 is its only milestone and it's done), then starting
CONTRACT-013 M5.**

Read this file, `AGENTS.md`, `docs/SYSTEM-SPECIFICATION.md`, and the active
contract's `contract.md` (with Amendments) before taking action. Check
`git status` and the relevant `evidence/*.md` files before assuming any
milestone's state -- they are the durable summary specifically so a fresh
session doesn't have to reconstruct it from `/tmp` artifacts or memory.

## Owner constraints (current, supersedes anything conflicting below CONTRACT-010)

- Claude is strategic orchestrator (owner-authorized role exchange with Codex,
  Amendment 1 to CONTRACT-011, 2026-08-09). Codex retains
  integrator/verifier/final-gate duties and is now also an automatic
  technical-fallback tier. DeepSeek remains the mandatory first executor for
  every programming task.
- Technical execution chain: `deepseek -> codex -> claude`, cheapest viable
  tier first, escalating only on *verified* same-task failure evidence
  (`src/policy/execution-permission.ts`, `src/policy/failure-classification.ts`).
  A transport/protocol failure must retry the same tier, never escalate.
- Executor-generated code must pass a deterministic format gate
  (`npm run format:check`, via `verificationCommandFor()`) before acceptance,
  not just tests -- code cleanliness is enforced mechanically, not left to
  whichever provider produced the patch.
- A provider must never review (`*_review` task classes) a task it executed as
  a technical-fallback tier on.
- Work is divided into small contracts containing several milestones. Commit
  and push exactly once after a whole contract passes every gate, never per
  milestone -- milestone evidence lives in each contract's `evidence/*.md`
  instead of separate commits. A contract's own charter file may be drafted
  as part of closing the contract before it (see CONTRACT-011's file
  ownership: `docs/contracts/CONTRACT-012/contract.md` is a narrow, explicit
  exception) -- that does not extend to the next contract's evidence or
  implementation files.
- Do not request approval for ordinary work (file edits, tests, disposable
  databases, docs). Ask only for destructive, irreversible, production, DNS,
  or secret-impacting operations -- and for anything touching the orphaned
  `polyptech-dashboard.service` (see Known issues below), since the owner has
  repeatedly asked for that to be left alone pending a deliberate decision.
- Default to the cheapest viable model for a role; escalate tiers only on
  verified failure evidence, never by default (token-efficiency principle,
  Amendment 1).

## Workspace

Canonical system: `/root/polyptechnology-next`. `/opt/master-orchestrator` no
longer exists on disk (already deleted). Do not treat its still-running
orphaned systemd service as something to silently fix or restart -- see Known
issues.

**Standing test invocation (zero skips):**

```
TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test \
TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 \
npm test
```

`TEST_WORKER_IMAGE` isn't a bug workaround -- `tests/docker-worker.integration.test.ts`
is deliberately gated behind it so ordinary runs don't pay a Docker-pull cost
by default. The digest above is `postgres:17-alpine`, already pulled for the
disposable database; any real pinned image works.

## CONTRACT-011 status: functionally complete, M0-M3

| Milestone | Status | Evidence |
|---|---|---|
| M0 | done | `docs/contracts/CONTRACT-011/contract.md` |
| M1 | done | `docs/contracts/CONTRACT-011/evidence/M1-fail-closed-routing.md` |
| M2 | done, wired into the live supervisor loop, verified with a **real** Docker sandbox (not fakes) | `docs/contracts/CONTRACT-011/evidence/M2-patch-executor.md` |
| M3 | done for the core lifecycle, two known sub-gaps (see evidence) | `docs/contracts/CONTRACT-011/evidence/M3-policy-persistence.md` |
| M4-M10 | descoped to `CONTRACT-012` (Amendment 2, 2026-08-09) | `docs/contracts/CONTRACT-012/contract.md` |

Full suite: 128 tests, 128 pass, 0 fail, 0 skip (standing invocation above).
`scripts/verify-contract.ts CONTRACT-011` passes (scope/ownership check).

### Commit/push checkpoint -- done

Committed and pushed 2026-08-09 at owner's explicit "push it" go-ahead:
`a564bf8`, `main` on `origin` (`https://github.com/her0ikur0i/polyptechnology.git`).
Working tree is clean. This checkpoint is historical -- do not re-commit or
re-push CONTRACT-011 work; the next commit belongs to CONTRACT-012 and
follows the same pattern (all gates green, scope check clean, one pause for
explicit confirmation before the actual `git push`).

## CONTRACT-012 status: M4 done and its only milestone (Amendment 1) -- ready to commit

| Milestone | Status | Evidence |
|---|---|---|
| M4 | done -- Control API server (Express 5), owner policy UI foundation, real live-process proof | `docs/contracts/CONTRACT-012/evidence/M4-control-api.md` |
| M5-M11 (original scope) | descoped to `CONTRACT-013` (Amendment 1, 2026-08-09) | `docs/contracts/CONTRACT-013/contract.md` |

Full backend suite: 136 tests, 136 pass, 0 fail, 0 skip (standing invocation
above, now includes migration 0010). Dashboard suite: 18/18 pass.
`npm run dashboard:build` succeeds. `scripts/verify-contract.ts CONTRACT-012`
passes. **Not yet committed** -- same commit/push checkpoint pattern as
CONTRACT-011: all gates green, scope check clean, one pause for explicit
confirmation before the actual `git push`.

**Owner decision recorded (2026-08-09):** verification for every generated
project uses a single pinned Node image (`node:22-bookworm-slim`) and the
chain `typecheck -> format:check -> test` until a real per-stack registry is
needed -- `src/operations/verification-image-policy.ts`.

**Real bug found live, not by tests alone (M4):** Express 5's router
(`path-to-regexp` v8) rejects a bare `"*"` wildcard route at server startup.
None of the integration tests caught it because none exercised the
SPA-serving code path -- only found by actually starting the server as a
live process and curling it. Fixed (`/*splat`) and now covered by an
automated test. Lesson for future milestones: run the real server as a live
process at least once per milestone, don't rely on integration tests alone
to prove a server actually boots.

## CONTRACT-013 status: drafted, not started

Carries forward CONTRACT-012's original M5-M11 (renumbered M5-M12 to make
room) plus five concrete gaps found while building/reviewing M4 -- see
`docs/contracts/CONTRACT-013/contract.md` for the full list folded into the
right milestones: no inbound Telegram webhook route, incomplete Policy UI
(rollback/override controls and dedicated envelope fields are missing even
though the client API functions already exist), no axe accessibility test
for the Policy page, no CSRF-rejection test for `/api/v1/policy/*`
specifically, and `ACCESS_AUTH_MODE=cloudflare` trusting header presence
without verifying the request actually transited Cloudflare Access. None of
these are fixed yet -- they're deliberately queued, not silently dropped.

## Known issues (do not silently resolve without confirmation)

- `polyptech-dashboard.service` is still active on the host
  (`dash.surachmancenter.com` -> `127.0.0.1:4173` via the live Cloudflare
  Tunnel, verified 2026-08-09), serving from a process whose files were
  deleted with `/opt/master-orchestrator`. It is **not** an old build of the
  current dashboard -- it's a pre-CONTRACT-007 combined-server architecture
  that no longer exists in this repo at all. The real, already-approved
  replacement (CONTRACT-010 Owner Action Bundle item 1: install at
  `/opt/polyp-ai-factory/current` under a dedicated `polyp-factory` system
  user, hardened systemd unit) was never executed -- verified 2026-08-09: no
  such path, no such user. Do not execute Owner Action Bundle items 1-5
  (production identity/release activation, DNS/Cloudflare cutover, Telegram
  live probe, external backups, production promotion) without a fresh
  explicit owner approval at the time -- CONTRACT-010 scoped these as
  owner-authority actions on purpose. Retire the orphaned service *at the
  same moment* a real replacement activates (CONTRACT-013 M9), not before --
  an availability gap on the public hostname is a real regression.
- `owner-policy-service.ts`'s `createCodexOverride`/`findActiveOverride` are
  not wired to `task_role_overrides` storage yet (`PostgresPolicyStore` has no
  read/write methods for that table). Real gap, see CONTRACT-011 M3 evidence.
- `scripts/policy-canary.ts` is a standalone script, not yet wired into
  `PostgresPolicyStore.validate()`. Run it by hand before approving any new
  `MODEL_POLICY_VERSION`.
- The only currently-running Postgres container is `polyp-contract006-pg`
  (port 55432) -- that belongs to an older contract, do not use it. A
  disposable container (`polyp-contract011-pg`, port 55433, migrations
  0001-0010 applied, shared across CONTRACT-011 and CONTRACT-012 for local
  test continuity) was created 2026-08-09; recreate it fresh if it no longer
  exists rather than reusing stale state.
- `PostgresPolicyStore` still has no read/write methods for
  `task_role_overrides` -- `POST /api/v1/policy/codex-override` (M4) is
  reachable but does not actually persist or read back the override it
  creates. Same gap CONTRACT-011 M3 evidence already flagged, unchanged.
- CONTRACT-008 left one ledger attempt (`66717047-593d-4976-b133-0a04d475e341`)
  in `outcome_unknown`, unreconciled -- relevant only to whichever database
  ends up being the real production one, not any disposable test DB.

## Resume instruction

Launch Claude Code in `/root/polyptechnology-next` and say "resume per
docs/RESUME.md". Read this file, `AGENTS.md`, `docs/SYSTEM-SPECIFICATION.md`,
`docs/contracts/CONTRACT-012/contract.md` (with Amendments), and
`docs/contracts/CONTRACT-013/contract.md` first. Check `git status` and both
contracts' `evidence/*.md` before doing anything else. CONTRACT-011 is
closed (`a564bf8`). If CONTRACT-012 (M4 only) is still uncommitted, the next
action is its commit/push checkpoint, not new work. Once committed, the next
action is CONTRACT-013 M5 in a fresh working tree.
