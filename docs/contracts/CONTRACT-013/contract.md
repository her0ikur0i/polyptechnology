# CONTRACT-013 — Generation pipeline, hardening, staging, and quality closeout

Status: draft (not yet started -- carries forward everything CONTRACT-012
Amendment 1 descoped, 2026-08-09)

## Objective

Make "generate a project through the DeepSeek -> Codex -> Claude routing
engine, observable from the dashboard" actually true end-to-end, close every
concrete gap found while building CONTRACT-011/012, independently review
security, reach a private staging instance, and finish with a deliberate
whole-repository quality pass before the single final commit.

## Depends on

CONTRACT-011 (accepted): routing/permission engine, `AiPatchExecutorDriver`.
CONTRACT-012 (accepted, M4 only): Control API server, owner policy UI
foundation. This contract does not re-open either -- it consumes and
completes them.

## Scope

- **Factory-to-executor wiring**: `src/factory/lifecycle.ts` gains a path
  that creates the `tasks`/`operation_task_specs` rows a real blueprint
  needs to reach `AiPatchExecutorDriver`. Without this, "generate project
  with the new routing" has no producer of tasks.
- **Policy UI completeness** (carried from CONTRACT-012 Amendment 1):
  rollback and Codex-override controls in `policy-control.tsx` (the API
  functions already exist, unused); dedicated envelope/concurrency/fallback
  fields instead of raw JSON editing.
- **Telegram webhook wiring** (carried from CONTRACT-012 Amendment 1):
  `parseTelegramCallback`/`handleTelegramCallback`
  (`src/telegram/gateway.ts`) actually reachable from a real Express route,
  with the secret-header validation `docs/operations/telegram-approvals.md`
  already specifies. Masked bot identity, webhook status, and decision
  history surfaced in the dashboard's Telegram settings view (currently only
  `configurationReady`).
- **Usage/attribution dashboard depth**: fallback reason and rework history,
  not just the current attempt list already shown.
- **End-to-end enforcement and negative tests** (carried from CONTRACT-012
  Amendment 1): axe accessibility coverage for the Policy page (only
  Overview is covered today); a CSRF-rejection test for `/api/v1/policy/*`
  specifically (only `/api/v1/settings/telegram` is covered today); restart
  and authorization negative tests generally.
- **Independent security review**, explicitly scoped to include (carried
  from CONTRACT-012 Amendment 1): `ACCESS_AUTH_MODE=cloudflare` trusts
  identity-header *presence* only today (`src/control-api/auth.ts`) -- no
  verification the request actually transited Cloudflare Access. Needs
  either origin-pull verification or a network-level guarantee (bind to
  localhost only, firewall direct access) before this is considered a real
  auth boundary rather than an honor system.
- **Immutable private staging deployment** -- reuses CONTRACT-010's
  already-approved, never-executed plan (see "Owner-authority checkpoints").
- **Owner acceptance checklist** and testable scenarios.
- **Repository-wide code quality cleanup**, placed last as the deliberate
  closing act (owner-requested 2026-08-09): deterministic formatting
  (`prettier --write .`) across every file CONTRACT-001 through
  CONTRACT-012 left unformatted, plus a dead-code/duplication audit across
  the accumulated source. Formatting-only changes reviewed separately from
  any behavioral fix a dead-code finding might require; full test suite
  green before and after.
- Evidence reconciliation, exactly one commit, and push.

## Out of scope

Public production cutover, DNS changes beyond the already-approved
CONTRACT-010 plan, secret disclosure/rotation, autonomous execution of Owner
Action Bundle items without a fresh explicit approval at the time they're
reached.

## Owner-authority checkpoints (do not execute without explicit approval)

CONTRACT-010's Owner Action Bundle
(`docs/contracts/CONTRACT-010/owner-action-bundle.md`) approved a production
deployment plan that was **never executed**: install at
`/opt/polyp-ai-factory/current` under a dedicated `polyp-factory` system
user, hardened systemd unit, Cloudflare Access/DNS cutover, Telegram live
probe, external backups. The currently-running `polyptech-dashboard.service`
(`/opt/master-orchestrator`, deleted, orphaned) is a pre-CONTRACT-007
artifact, not a stale build of the current system -- retire it *at the same
moment* the real replacement activates, not before (an availability gap on
`dash.surachmancenter.com` is a real regression). This contract's staging
milestone is scoped to a **private, non-public** instance; the public
hostname cutover remains a separate, explicit approval.

## Milestones

1. M5: factory-to-executor task creation wiring.
2. M6: policy UI completeness (rollback/override controls, dedicated
   envelope fields), Telegram webhook wiring, usage/attribution dashboard
   depth.
3. M7: end-to-end enforcement, restart, authorization, and accessibility
   negative tests (including the two test gaps listed in Scope).
4. M8: independent security review (including the Cloudflare Access
   boundary hardening listed in Scope), remediation, final technical gates.
5. M9: immutable **private** staging deployment, activation, health,
   rollback proof (no public cutover).
6. M10: owner acceptance checklist and testable scenarios.
7. M11: repository-wide code quality cleanup (formatting + dead-code/
   duplication audit), the deliberate closing act before commit.
8. M12: evidence reconciliation, exactly one commit, and push.

## Gates

- A real blueprint generates end-to-end through DeepSeek's routing and the
  isolated patch verifier, observable from the dashboard -- not just proven
  at the driver level (CONTRACT-011) but reachable from a real owner action.
- Telegram Approve/Deny actually round-trips through a live webhook, not
  just unit-tested parsing.
- `ACCESS_AUTH_MODE=cloudflare` has a verified, not assumed, trust boundary.
- `npm run format:check` passes with zero warnings repository-wide before
  M12's commit -- M11's file ownership extends to `**` for that milestone
  only, formatting changes only, no behavioral edits smuggled into the same
  commit.
- Fresh migrations, locked install, full backend/dashboard/integration
  tests, build, `format:check`, audit, scope, diff, secret, and
  independent-review gates pass with zero skips.
- Staging is private, healthy, restartable, rollback-tested, and accessible
  for the documented owner acceptance procedure -- and does not touch the
  public `dash.surachmancenter.com` hostname without a separate, explicit
  owner approval at that point.

## Acceptance

- A real managed programming scenario, started from the dashboard, routes
  through DeepSeek -> Codex -> Claude as designed and stores an attributable
  patch.
- From the dashboard, the owner can inspect and adjust allowed routes, role
  exchange, execution envelope, concurrency, fallback, and cost guardrails
  through the full policy lifecycle including rollback.
- Telegram approval delivery and decision are both observable and testable
  from the dashboard, not just the settings form.
- Usage and artifact views reconcile concrete requested/resolved models,
  tokens, costs, artifacts, changed lines, outcomes, verification, and
  fallback reason -- with live data.
- The owner can access the private staging dashboard and execute the
  acceptance checklist without editing server files.
- `npm run format:check` reports zero warnings across the entire repository.

## Rollback

Activate the preceding immutable policy version and staging release, stop
the new unit if health fails, restore the pre-migration backup when schema
rollback is required. Provider attempts and audit/provenance records remain
immutable.

## File ownership

- `docs/contracts/CONTRACT-013/**`
- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/operations/**`
- `docs/security/**`
- `src/dashboard/**`
- `src/control-api/**`
- `src/factory/**`
- `src/telegram/**`
- `src/approvals/**`
- `src/policy/**`
- `src/operations/**`
- `src/orchestrator/**`
- `deploy/**`
- `.github/workflows/**`
- `tests/**`
- `package.json`
- `package-lock.json`

M11 (code quality cleanup) is the sole, explicit, temporary exception: its
file ownership extends to `**` for formatting-only changes, reverting to the
list above for every other milestone.
