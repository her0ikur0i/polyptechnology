# Resume checkpoint

## Active objective

`CONTRACT-011` (`a564bf8`) and `CONTRACT-012` (`4342ca2`) are both
**committed and pushed** to `main` on `origin`, owner-approved. CONTRACT-011
was scoped to M0-M3 (Amendment 2); CONTRACT-012 to M4 only (Amendment 1).
Everything after M4, plus every concrete gap found while building and
reviewing it, was queued as `CONTRACT-013`
(`docs/contracts/CONTRACT-013/contract.md`), **all 12 milestones (M5-M12)
now done, all gates green, working tree not yet committed**. **The next
action in a fresh session is either: (a) if the working tree still has
CONTRACT-013's uncommitted changes, get the owner's explicit "push it"
go-ahead and perform the single final commit/push per M12; or (b) if
`git log` shows CONTRACT-013 already committed and pushed, start planning
the next contract from scratch (M9's private-staging decisions and M11's
queued dead-code/duplication findings are good candidates for its scope).**

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
  tier first, escalating only on _verified_ same-task failure evidence
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

| Milestone | Status                                                                                         | Evidence                                                         |
| --------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| M0        | done                                                                                           | `docs/contracts/CONTRACT-011/contract.md`                        |
| M1        | done                                                                                           | `docs/contracts/CONTRACT-011/evidence/M1-fail-closed-routing.md` |
| M2        | done, wired into the live supervisor loop, verified with a **real** Docker sandbox (not fakes) | `docs/contracts/CONTRACT-011/evidence/M2-patch-executor.md`      |
| M3        | done for the core lifecycle, two known sub-gaps (see evidence)                                 | `docs/contracts/CONTRACT-011/evidence/M3-policy-persistence.md`  |
| M4-M10    | descoped to `CONTRACT-012` (Amendment 2, 2026-08-09)                                           | `docs/contracts/CONTRACT-012/contract.md`                        |

Full suite: 128 tests, 128 pass, 0 fail, 0 skip (standing invocation above).
`scripts/verify-contract.ts CONTRACT-011` passes (scope/ownership check).

### Commit/push checkpoint -- done

Committed and pushed 2026-08-09 at owner's explicit "push it" go-ahead:
`a564bf8`, `main` on `origin` (`https://github.com/her0ikur0i/polyptechnology.git`).
Working tree is clean. This checkpoint is historical -- do not re-commit or
re-push CONTRACT-011 work; the next commit belongs to CONTRACT-012 and
follows the same pattern (all gates green, scope check clean, one pause for
explicit confirmation before the actual `git push`).

## CONTRACT-012 status: closed (`4342ca2`)

| Milestone               | Status                                                                                      | Evidence                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| M4                      | done -- Control API server (Express 5), owner policy UI foundation, real live-process proof | `docs/contracts/CONTRACT-012/evidence/M4-control-api.md` |
| M5-M11 (original scope) | descoped to `CONTRACT-013` (Amendment 1, 2026-08-09)                                        | `docs/contracts/CONTRACT-013/contract.md`                |

Full backend suite: 136 tests, 136 pass, 0 fail, 0 skip (standing invocation
above, now includes migration 0010). Dashboard suite: 18/18 pass.
`npm run dashboard:build` succeeds. `scripts/verify-contract.ts CONTRACT-012`
passed. Committed and pushed 2026-08-09 at owner's explicit "push it"
go-ahead: `4342ca2`, `main` on `origin`. This checkpoint is historical -- do
not re-commit or re-push CONTRACT-012 work.

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

## CONTRACT-013 status: M5-M11 done, M12 not started

| Milestone | Status                                                                                                                                                                                                                                                                                                                                                                                                                                | Evidence                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| M5        | done -- real generation pipeline (blueprint -> workspace -> queued task -> executed -> accepted patch), `AiGateway`/`RuntimePolicy` reconciled, 5 real bugs found and fixed                                                                                                                                                                                                                                                           | `docs/contracts/CONTRACT-013/evidence/M5-generation-pipeline.md`   |
| M6        | done -- `task_role_overrides` storage wired for real (was a stub), Policy UI rollback/override controls + dedicated envelope fields, Telegram webhook confirmed, usage/attribution dashboard depth (fallback reason, rework history) -- all live-verified against a running server                                                                                                                                                    | `docs/contracts/CONTRACT-013/evidence/M6-policy-telegram-usage.md` |
| M7        | done -- axe coverage for the Policy page, CSRF-rejection matrix for all `/api/v1/policy/*` mutation routes, broadened cross-route authorization negative test, restart/ephemeral-CSRF-secret test                                                                                                                                                                                                                                     | `docs/contracts/CONTRACT-013/evidence/M7-negative-tests.md`        |
| M8        | done -- independent security review (`docs/security/CONTRACT-013-M8-review.md`); fixed: `ACCESS_AUTH_MODE=cloudflare` now refuses to start unless bound to loopback (was an honor system); everything else reviewed clean or deliberately deferred (rate limiting, out of scope for private staging)                                                                                                                                  | `docs/contracts/CONTRACT-013/evidence/M8-security-review.md`       |
| M9        | done -- private staging deployed for real (`polyp-control-api.service`, loopback port 4180, real staging Postgres, hardened systemd unit), health + rollback proven live, one real bug found and fixed by booting the compiled server (dashboard SPA path resolution)                                                                                                                                                                 | `docs/contracts/CONTRACT-013/evidence/M9-private-staging.md`       |
| M10       | done -- owner acceptance checklist (`docs/contracts/CONTRACT-013/acceptance-checklist.md`) mapping all 6 contract acceptance bullets to status+evidence; closed a real gap found while writing it (Telegram decisions/webhook status now observable from the dashboard, not just the settings form)                                                                                                                                   | `docs/contracts/CONTRACT-013/evidence/M10-acceptance.md`           |
| M11       | done -- `prettier --write .` repository-wide (46 files, all confirmed formatting-only by diff review), zero `format:check` warnings; dead-code/duplication audit (independent fork): 1 unused export removed (in CONTRACT-013's ownership), 3 dead files + 2 duplication candidates documented and queued to a future contract (outside CONTRACT-013's ownership or deliberately not worth the risk this close to the closing commit) | `docs/contracts/CONTRACT-013/evidence/M11-code-quality-cleanup.md` |
| M12       | not started                                                                                                                                                                                                                                                                                                                                                                                                                           | --                                                                 |

Full suite (fresh disposable DB, migrations 0001-0010): 164 tests, 164 pass,
0 fail, 0 skip. Dashboard: 19/19. `npm audit` (dev+prod): 0 vulnerabilities.
`npm run format:check`: zero warnings, repository-wide.

`scripts/verify-contract.ts CONTRACT-013` currently reports dirty
out-of-scope paths -- **expected**, not a regression: the checker has no
notion of milestones and doesn't know about M11's explicit, contract
-documented `**` exception for formatting-only changes. Every flagged path
was manually diff-reviewed and confirmed formatting-only (see M11 evidence).
This will still show at M12 commit time for the same reason -- resolve by
manual review before committing, not by treating the tool's output as
gospel over the contract's own written exception.

Carried forward CONTRACT-012's original M5-M11 (renumbered M5-M12) plus five
concrete gaps found while building/reviewing M4 -- all five are now closed:
inbound Telegram webhook route (M5/M6), Policy UI rollback/override controls
and dedicated envelope fields (M6), axe accessibility test for the Policy
page (M7), CSRF-rejection test for `/api/v1/policy/*` (M7), and
`ACCESS_AUTH_MODE=cloudflare` trusting header presence without a
network-level guarantee (M8, loopback-bind enforcement -- full JWT
verification against Cloudflare's Access certs remains a documented future
step, not yet implemented).

Not yet committed -- working tree still has all of CONTRACT-013's changes
uncommitted, per the standing pattern (commit once at M12, not per
milestone).

## Known issues (do not silently resolve without confirmation)

- `polyptech-dashboard.service` is still active on the host
  (`dash.surachmancenter.com` -> `127.0.0.1:4173` via the live Cloudflare
  Tunnel, verified 2026-08-09), serving from a process whose files were
  deleted with `/opt/master-orchestrator`. It is **not** an old build of the
  current dashboard -- it's a pre-CONTRACT-007 combined-server architecture
  that no longer exists in this repo at all. **Still untouched** -- do not
  stop, restart, or otherwise modify it without fresh explicit owner
  approval. `/opt/polyp-ai-factory/current`, the `polyp-factory` system
  user, and a hardened systemd unit now exist for real (CONTRACT-013 M9,
  2026-08-09), but that is a **private staging** instance only
  (`polyp-control-api.service`, loopback-bound port 4180, `ACCESS_AUTH_MODE=disabled`,
  no Telegram, no background task-execution supervisor running -- see M9
  evidence) -- not the public production cutover. Do not execute the
  remaining CONTRACT-010 Owner Action Bundle items (DNS/Cloudflare cutover,
  Telegram live probe, external backups, production promotion) or retire
  the orphaned service without a fresh explicit owner approval at the time;
  CONTRACT-013's own scope explicitly excludes the public hostname cutover.
- `scripts/policy-canary.ts` is a standalone script, not yet wired into
  `PostgresPolicyStore.validate()`. Run it by hand before approving any new
  `MODEL_POLICY_VERSION`.
- Postgres containers now running: `polyp-contract006-pg` (port 55432, an
  older contract, do not use), `polyp-contract011-pg` (port 55433,
  disposable test database, migrations 0001-0010, recreate fresh if it no
  longer exists or gets polluted -- do not try to delete rows from its
  audit-immutable tables, recreate instead), `polyp-staging-pg` (port 55434,
  loopback-bound, **persistent** named volume `polyp-staging-pg-data`, real
  data for the M9 private staging instance -- do not treat as disposable).
- CONTRACT-008 left one ledger attempt (`66717047-593d-4976-b133-0a04d475e341`)
  in `outcome_unknown`, unreconciled -- relevant only to whichever database
  ends up being the real production one, not any disposable test DB.

## Resume instruction

Launch Claude Code in `/root/polyptechnology-next` and say "resume per
docs/RESUME.md". Read this file, `AGENTS.md`, `docs/SYSTEM-SPECIFICATION.md`,
and `docs/contracts/CONTRACT-013/contract.md` first. Check `git status` and
`docs/contracts/CONTRACT-013/evidence/*.md` before doing anything else --
they are the durable summary specifically so a fresh session doesn't have to
reconstruct state from memory.

CONTRACT-011 (`a564bf8`) and CONTRACT-012 (`4342ca2`) are both closed and
pushed. CONTRACT-013's M5-M12 are all done, all gates green (164/164 backend
tests, 19/19 dashboard, zero `format:check` warnings, zero `npm audit`
vulnerabilities, secret-pattern scan clean) -- **check `git log --oneline -3`
first**: if the top commit is still `5e5569a`/`d92558e` (CONTRACT-012's
close), CONTRACT-013's work is real but uncommitted, and the next action is
getting the owner's explicit "push it" go-ahead for the single final commit
(M12 evidence has the exact reconciliation). If a newer commit already
exists on top, CONTRACT-013 is closed -- read its evidence for what changed,
then start planning the next contract (candidates already identified: M9's
deferred real-provider-credentialed drill, M11's queued dead-code files
outside CONTRACT-013's ownership, the safePath/safeWorkerPath duplication,
and completing the Cloudflare Access JWT verification M8 left as a
network-level-guarantee interim fix).
