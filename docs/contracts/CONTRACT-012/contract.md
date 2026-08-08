# CONTRACT-012 — Master Dashboard Control API, owner policy UI, and staging cutover

Status: draft (not yet started -- descoped out of CONTRACT-011, 2026-08-09)

## Objective

Build the Control API server the existing dashboard SPA has always expected
but never had, add owner-facing policy controls on top of CONTRACT-011's
policy engine, prove the whole system end-to-end, and get the owner to a
private, testable, rollback-safe staging instance.

## Depends on

CONTRACT-011 (accepted): `AiGateway`, the 3-tier deepseek->codex->claude
routing/permission engine, `OwnerPolicyService`, `AiPatchExecutorDriver`
wired into the live supervisor loop, and the code-cleanliness verification
gate. This contract does not re-open any of that -- it consumes it.

## Scope

- **Control API server** (Express 5, per `docs/SYSTEM-SPECIFICATION.md`'s
  tech baseline): implements every route `src/dashboard/api.ts` already
  calls (`GET /api/v1/dashboard/snapshot`, `PUT /api/v1/settings/telegram`,
  `POST /api/v1/factory/projects`, `POST /api/v1/orchestrator/proposals`) --
  none of these exist server-side today (verified 2026-08-09: zero
  references outside the client file itself, no HTTP framework installed).
  Owner auth boundary, CSRF issuance, and serving the built `dist-dashboard/`
  SPA are part of this, not a separate step.
- **Owner policy UI**: new dashboard route(s) and API endpoints wiring
  `OwnerPolicyService` (draft/validate/approve/activate/rollback/simulate,
  Codex override grants) into the existing dashboard shell
  (`src/dashboard/app.tsx`'s nav/routing pattern), reusing its established
  component/design-token conventions (`src/dashboard/components.tsx`,
  `styles.css`) rather than introducing a second visual language.
- **Factory-to-executor wiring**: `src/factory/lifecycle.ts` gains a path
  that creates the `tasks`/`operation_task_specs` rows a real blueprint
  needs so "generate project with the new model routing" is possible
  end-to-end -- CONTRACT-011 left this open on purpose (the driver existed
  but nothing called it from the factory side).
- **Usage/attribution dashboard**: provider/model usage, artifact
  attribution, fallback reason, and rework views (the `Providers & Models`
  page already exists and renders `ModelAttempt[]` -- this extends it with
  live server data instead of nothing, since no server exists yet).
- End-to-end enforcement, restart, and authorization negative tests.
- Independent security review and remediation.
- Immutable private staging deployment -- see "Production cutover" below,
  this explicitly reuses CONTRACT-010's already-approved, never-executed
  plan rather than inventing a new one.
- Owner acceptance checklist and testable scenarios.
- Evidence reconciliation, exactly one commit, and push.

## Out of scope

Public production cutover, DNS changes beyond the already-approved
CONTRACT-010 plan, secret disclosure/rotation, autonomous execution of
Owner Action Bundle items without a fresh explicit approval at the time
they're reached (see "Owner-authority checkpoints" below).

## Owner-authority checkpoints (do not execute without explicit approval)

CONTRACT-010's Owner Action Bundle (`docs/contracts/CONTRACT-010/owner-action-bundle.md`)
approved a production deployment plan that was **never executed**: install at
`/opt/polyp-ai-factory/current` under a dedicated `polyp-factory` system
user, hardened systemd unit, Cloudflare Access/DNS cutover, Telegram live
probe, external backups. The currently-running `polyptech-dashboard.service`
(`/opt/master-orchestrator`, deleted, orphaned) is a pre-CONTRACT-007
artifact, not a stale build of the current system -- it must be retired
*at the same moment* the real replacement activates, not before (an
availability gap on `dash.surachmancenter.com` is a real regression, not a
cosmetic one). This contract's M8 (staging) is scoped to a **private,
non-public** instance the owner can reach for acceptance testing; the actual
cutover of the public hostname remains a separate, explicit approval, same
as CONTRACT-010 defined it.

## Milestones

1. M4: Control API server (all routes the SPA already expects) + owner
   policy UI wired to `OwnerPolicyService`.
2. M5: factory-to-executor task creation wiring; usage/attribution dashboard
   with live data.
3. M6: end-to-end enforcement, restart, and authorization negative tests.
4. M7: independent security review, remediation, final technical gates.
5. M8: immutable **private** staging deployment, activation, health,
   rollback proof (no public cutover).
6. M9: owner acceptance checklist and testable scenarios.
7. M10: evidence reconciliation, exactly one commit, and push.

## Gates

- Every route the dashboard SPA calls has a real, tested server
  implementation -- no client code ships against an endpoint that doesn't
  exist, reversing the gap CONTRACT-011 found.
- Dashboard controls operate against persisted runtime policy, not mock
  state.
- A real blueprint can be generated end-to-end through DeepSeek's routing
  and the isolated patch verifier, observable from the dashboard.
- Fresh migrations, locked install, full backend/dashboard/integration
  tests, build, `format:check`, audit, scope, diff, secret, and
  independent-review gates pass with zero skips.
- Staging is private, healthy, restartable, rollback-tested, and accessible
  for the documented owner acceptance procedure -- and does not touch the
  public `dash.surachmancenter.com` hostname without a separate, explicit
  owner approval at that point.

## Acceptance

- From the dashboard, the owner can inspect and adjust allowed routes, role
  exchange, execution envelope, concurrency, fallback, and cost guardrails
  through a draft/simulate/approve/activate lifecycle.
- A real managed programming scenario, started from the dashboard, routes
  through DeepSeek -> Codex -> Claude as designed and stores an attributable
  patch.
- Usage and artifact views reconcile concrete requested/resolved models,
  tokens, costs, artifacts, changed lines, outcomes, verification, and
  fallback reason -- with live data, not fixtures.
- The owner can access the private staging dashboard and execute the
  acceptance checklist without editing server files.

## Rollback

Activate the preceding immutable policy version and staging release, stop
the new unit if health fails, restore the pre-migration backup when schema
rollback is required. Provider attempts and audit/provenance records remain
immutable.

## File ownership

- `docs/contracts/CONTRACT-012/**`
- `docs/RESUME.md`
- `docs/architecture/**`
- `src/dashboard/**`
- `src/factory/**`
- `src/policy/**` (read-only consumer; no new routing/permission semantics)
- `tests/dashboard/**`
- `tests/**`
- `package.json`
- `package-lock.json`
