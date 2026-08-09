# M4 — Control API server, owner policy UI

Status: done, 2026-08-09.

## What changed

- `migrations/0010_control_api.sql`: `telegram_settings` singleton table --
  references only (`secret_ref`, authorized chat/user ID arrays); the actual
  `TELEGRAM_BOT_TOKEN` stays in env and never touches Postgres or the
  browser, matching `docs/operations/telegram-approvals.md`'s stated
  boundary.
- `src/approvals/postgres-repository.ts`: added `list()` -- the repository
  only had `find(id)`/`create`/`decide` before, no way to list approvals for
  a dashboard view.
- `src/control-api/snapshot.ts`: aggregates real Postgres data into the
  `DashboardSnapshot` shape `src/dashboard/types.ts` already declared --
  projects (`generated_projects`), contracts (`factory_contracts` +
  `milestones` + `gate_evidence`), attempts (`ai_gateway_attempts` +
  `ai_usage_events` + `ai_attempt_verifications`), approvals, telegram
  settings, sequence state (`sequence_supervisor` +
  `sequence_owner_blockers`), and a computed `attention` feed (owner-blocked
  sequence state, approvals expiring within an hour). No field is invented --
  where the schema has no natural source (e.g. `factory_contracts` has no
  title column), the code says so in a comment rather than fabricating one.
- `src/control-api/auth.ts`: owner identity + CSRF middleware.
  `ACCESS_AUTH_MODE=disabled` (local dev only, `config.ts` already forbids it
  in production) trusts every request; `cloudflare` mode reads the standard
  `Cf-Access-Authenticated-User-Email` header, trusting Cloudflare Access to
  have authenticated upstream -- this server never runs its own login flow,
  per ADR-0003. CSRF is the same double-submit shared-secret comparison
  `OwnerCommandService.authorize()` already used, not a new mechanism.
- `src/config.ts`: added `csrfSecret` (required, >=32 chars, in production;
  auto-generated ephemeral in dev/test).
- `src/control-api/app.ts` (`createControlApi`): the actual Express 5
  server. Implements the four routes `src/dashboard/api.ts` already called
  with nothing behind them (`GET /api/v1/dashboard/snapshot`,
  `PUT /api/v1/settings/telegram`, `POST /api/v1/factory/projects`,
  `POST /api/v1/orchestrator/proposals`), plus new policy routes
  (`POST /api/v1/policy/{draft,validate,approve,activate,rollback,simulate,
codex-override}`, `GET /api/v1/policy/:policyKey/active`) wired to
  `OwnerPolicyService`. Serves the built `dist-dashboard/` SPA with a
  client-side-routing fallback.
- `src/control-api/server.ts` + `package.json` `dev`/`start`: the real
  entrypoint, replacing the old broken assumption of a
  `src/dashboard/server.ts` that never existed in this codebase.
- `src/dashboard/api.ts`: client functions for the policy lifecycle
  (`createPolicyDraft`, `validatePolicyDraft`, `approvePolicyDraft`,
  `activatePolicyDraft`, `rollbackPolicy`, `loadActivePolicy`), matching the
  existing `commandRequest`/CSRF pattern exactly.
- `src/dashboard/policy-control.tsx` + `app.tsx`: new "Policy" nav entry and
  page using the existing component library (`Panel`, `StatusBadge`) --
  draft/validate/approve/activate a routing policy from the dashboard, with
  the active policy's state visible. No new visual language introduced.

## Real bug found and fixed (not caught by unit/integration tests alone)

Express 5's router (`path-to-regexp` v8) rejects a bare `"*"` wildcard route
at _startup_ -- `createControlApi()` threw immediately when
`dashboardDistPath` was supplied. None of the integration tests caught this
because none of them exercised the SPA-serving code path. Found by actually
starting the server as a live process and curling it (not just running the
test suite) -- fixed (`/*splat` per Express 5's named-wildcard syntax) and
now covered by an automated test
(`tests/control-api.integration.test.ts`: "serves the built dashboard SPA
and falls back to index.html for client routes") so it can't silently
regress again.

## Test evidence

Full backend suite (zero skips):

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 136
# pass 136
# fail 0
# skipped 0
```

Dashboard suite:

```
npm run dashboard:test
# Test Files  5 passed (5)
# Tests  18 passed (18)
```

`npm run dashboard:build` succeeds (real Vite build, not just typecheck).
`scripts/verify-contract.ts CONTRACT-012` passes (scope/ownership check).

**Live process proof**, not just tests: started the real server against the
disposable database (`DATABASE_URL=... PORT=4174 ... node --import tsx
src/control-api/server.ts`) and curled it directly --
`GET /api/v1/dashboard/snapshot` returned real project/contract/attempt data
seeded by earlier test runs, `GET /policy` (an SPA client route, not a real
file) correctly served the built `index.html` via the fallback, and
`GET /api/v1/policy/bulk_code_default/active` correctly returned 404 before
any policy had been activated for that key.

## What is still open (M5+)

- `src/factory/lifecycle.ts` still has no path from a real blueprint to
  `AiPatchExecutorDriver` -- CONTRACT-011 left this open, M4 didn't need to
  close it (the Control API can create/observe projects and policy, but
  can't yet trigger real code generation end-to-end).
- The dashboard snapshot has no "recent policy activity" feed -- the Policy
  page shows current draft/active state but not a history view. Not
  required by CONTRACT-012's M4 acceptance criteria; worth considering for
  M5's usage/attribution work.
- `owner-policy-service.ts`'s `createCodexOverride`/`findActiveOverride`
  remain unwired to `task_role_overrides` storage (a CONTRACT-011 gap,
  unchanged by M4) -- the `/api/v1/policy/codex-override` route exists and
  is reachable, but the override it creates isn't actually persisted or
  read back yet.
