# Resume checkpoint

## Active objective

`CONTRACT-011` is functionally complete (M0-M3, descoped by its own
Amendment 2 on 2026-08-09) and ready to close with one commit + push once the
owner gives the final go-ahead (see "Commit/push checkpoint" below). The
remaining original scope (M4-M10: Control API server, owner policy UI,
factory-to-executor wiring, staging, acceptance) is drafted as
`CONTRACT-012` (status: draft, not started) --
`docs/contracts/CONTRACT-012/contract.md`.

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

### Commit/push checkpoint (do not push without a final owner go-ahead)

Everything is staged (`git add -A` was run 2026-08-09) but **not committed**.
Per the project's own rule, commit happens exactly once after all of a
contract's gates pass -- they do. Before the actual `git commit && git push`:
re-run the standing test invocation above one more time, confirm
`scripts/verify-contract.ts CONTRACT-011` still passes, then pause for one
explicit confirmation before `git push` specifically (it touches shared
remote state) -- this was already agreed with the owner as the one
non-negotiable pause point even under otherwise-autonomous execution.

## CONTRACT-012 status: drafted, not started

See `docs/contracts/CONTRACT-012/contract.md` for full scope. Two findings
from CONTRACT-011 that shape it and must not be re-litigated:

1. **No Control API server exists.** `src/dashboard/api.ts` (client
   `fetch()` calls) is the *only* reference to
   `/api/v1/dashboard/snapshot`, `/api/v1/settings/telegram`,
   `/api/v1/factory/projects`, `/api/v1/orchestrator/proposals` anywhere in
   the codebase -- no HTTP framework is even installed. The dashboard SPA
   itself is real, tested (against fixtures), and built
   (`dist-dashboard/`) -- CONTRACT-010's "release-ready" claim was true for
   what it tested, it just never implied a live server existed. Express 5 is
   already the decided framework (`docs/SYSTEM-SPECIFICATION.md`), so this
   is unbuilt scope, not an open decision.
2. **`src/factory/lifecycle.ts` has zero references to `AiGateway` or
   `model-policy`.** M2's `AiPatchExecutorDriver` is ready and proven
   end-to-end, but nothing creates the `tasks`/`operation_task_specs` rows a
   real blueprint needs to reach it. "Generate project with the new routing"
   has no producer of tasks yet.

**Owner decision recorded (2026-08-09):** verification for every generated
project uses a single pinned Node image (`node:22-bookworm-slim`) and the
chain `typecheck -> format:check -> test` until a real per-stack registry is
needed -- `src/operations/verification-image-policy.ts`.

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
  same moment* a real replacement activates (CONTRACT-012 M8), not before --
  an availability gap on the public hostname is a real regression.
- `owner-policy-service.ts`'s `createCodexOverride`/`findActiveOverride` are
  not wired to `task_role_overrides` storage yet (`PostgresPolicyStore` has no
  read/write methods for that table). Real gap, see CONTRACT-011 M3 evidence.
- `scripts/policy-canary.ts` is a standalone script, not yet wired into
  `PostgresPolicyStore.validate()`. Run it by hand before approving any new
  `MODEL_POLICY_VERSION`.
- The only currently-running Postgres container is `polyp-contract006-pg`
  (port 55432) -- that belongs to an older contract, do not use it. A
  disposable CONTRACT-011 container (`polyp-contract011-pg`, port 55433,
  migrations 0001-0009 applied) was created 2026-08-09; recreate it fresh if
  it no longer exists rather than reusing stale state.
- CONTRACT-008 left one ledger attempt (`66717047-593d-4976-b133-0a04d475e341`)
  in `outcome_unknown`, unreconciled -- relevant only to whichever database
  ends up being the real production one, not any disposable test DB.

## Resume instruction

Launch Claude Code in `/root/polyptechnology-next` and say "resume per
docs/RESUME.md". Read this file, `AGENTS.md`, `docs/SYSTEM-SPECIFICATION.md`,
and the active contract's `contract.md` (with Amendments) first. Check
`git status` and `evidence/*.md` before doing anything else. If CONTRACT-011
is still uncommitted, the next action is the commit/push checkpoint above,
not new work. If it has already been committed and pushed, the next action
is starting CONTRACT-012 M4.
