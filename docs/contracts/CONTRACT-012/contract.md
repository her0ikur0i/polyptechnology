# CONTRACT-012 — Master Dashboard Control API and owner policy UI

Status: active (descoped to M4 only by Amendment 1, 2026-08-09 -- M5 onward
plus newly-found gaps move to CONTRACT-013)

## Objective

Build the Control API server the existing dashboard SPA has always expected
but never had, and add owner-facing policy controls on top of CONTRACT-011's
policy engine. Proving the whole system end-to-end and staging cutover move
to CONTRACT-013 (Amendment 1) -- this contract closes at the same coherent,
gate-checkable size CONTRACT-011 did.

## Amendment 1 (2026-08-09) — descoped to M4, gaps found during it queued forward

Owner-requested, mirroring CONTRACT-011's own Amendment 2. M5-M11 as
originally scoped below move to `CONTRACT-013`
(`docs/contracts/CONTRACT-013/contract.md`), along with concrete gaps found
while building and reviewing M4 that were not part of M4's own acceptance
criteria and should not silently become undocumented debt:

- **No inbound Telegram webhook route.** `parseTelegramCallback`/
  `handleTelegramCallback` (`src/telegram/gateway.ts`, built in an earlier
  contract) are never called from `src/control-api/app.ts` -- an
  Approve/Deny tap in Telegram has nowhere to land.
- **Policy UI is incomplete relative to what the client already supports.**
  `rollbackPolicy` and the Codex-override command exist in
  `src/dashboard/api.ts` with no UI trigger in `policy-control.tsx`. The
  policy document is edited as raw JSON, not the dedicated envelope/
  concurrency/fallback fields CONTRACT-012's own Acceptance section
  describes ("owner can inspect and adjust ... execution envelope,
  concurrency ... through a draft/simulate/approve/activate lifecycle").
- **No accessibility (axe) test for the new Policy page** --
  `tests/dashboard/app.test.tsx` only runs `axe.run()` against Overview.
- **No CSRF-rejection test for `/api/v1/policy/*`** specifically -- only
  `/api/v1/settings/telegram` is covered; the policy routes could regress
  silently.
- **`ACCESS_AUTH_MODE=cloudflare` trusts header _presence_ only** --
  `identifyOwner()` never verifies the request actually transited Cloudflare
  Access; if the app were ever reachable directly (bypassing the tunnel),
  the identity header is spoofable. Needs either origin-pull verification or
  a network-level guarantee (bind to localhost, firewall direct access) as
  part of a real security review, not left implicit.

These are listed here (not fixed here) precisely so they get scoped and
gated deliberately in CONTRACT-013 rather than discovered again from
scratch.

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
- **Owner policy UI**: new dashboard route wiring `OwnerPolicyService`
  (draft/validate/approve/activate) into the existing dashboard shell
  (`src/dashboard/app.tsx`'s nav/routing pattern), reusing its established
  component/design-token conventions (`src/dashboard/components.tsx`,
  `styles.css`) rather than introducing a second visual language. Full
  parity with every command the client already supports (rollback, Codex
  override, dedicated envelope fields instead of raw JSON) is CONTRACT-013's
  job, per Amendment 1.

(Factory-to-executor wiring, usage/attribution dashboard depth, end-to-end
enforcement tests, security review, staging, owner acceptance, cleanup, and
final commit all move to CONTRACT-013 per Amendment 1 -- not this contract's
scope anymore.)

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
_at the same moment_ the real replacement activates, not before (an
availability gap on `dash.surachmancenter.com` is a real regression, not a
cosmetic one). Staging/cutover itself is CONTRACT-013 scope (M8 there); this
note carries forward so it isn't rediscovered from zero.

## Milestones

1. M4: Control API server (all routes the SPA already expects) + owner
   policy UI wired to `OwnerPolicyService`'s draft/validate/approve/activate
   lifecycle.

(M5 onward -- factory-to-executor wiring, usage/attribution depth, e2e
tests, security review, staging, acceptance, cleanup, final commit -- is
`CONTRACT-013`, per Amendment 1.)

## Gates

- Every route the dashboard SPA calls has a real, tested server
  implementation -- no client code ships against an endpoint that doesn't
  exist, reversing the gap CONTRACT-011 found.
- Dashboard controls operate against persisted runtime policy, not mock
  state.
- Fresh migrations, locked install, full backend/dashboard/integration
  tests, build, `format:check`, audit, scope, diff, and secret gates pass
  with zero skips.

## Acceptance

- From the dashboard, the owner can draft, validate, approve, and activate a
  routing policy version, and see the active policy's state.
- The four routes the SPA already called are real and tested against a live
  Postgres, not fixtures: dashboard snapshot, Telegram settings, project
  creation, proposal creation.
- The server runs as a real live process (verified, not just test-suite
  green) and correctly serves the built SPA with client-side routing
  fallback.

(Owner-adjustable execution envelope/concurrency fields, rollback/override
UI, a real generated-project scenario routed through DeepSeek -> Codex ->
Claude, and staging access are CONTRACT-013's acceptance criteria, per
Amendment 1.)

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
- `src/control-api/**`
- `src/factory/**`
- `src/approvals/**`
- `src/policy/**`
- `src/config.ts`
- `migrations/0010_control_api.sql`
- `tests/dashboard/**`
- `tests/**`
- `package.json`
- `package-lock.json`
- `docs/contracts/CONTRACT-013/contract.md`

`src/policy/**` is a read-only consumer here -- CONTRACT-012 wires
`OwnerPolicyService` into HTTP routes, it does not add new
routing/permission semantics (that stays CONTRACT-011's finished scope).
The last entry mirrors CONTRACT-011's own exception: drafting the handoff
contract's charter is part of closing this one out, and does not extend to
CONTRACT-013's own evidence or implementation files.
