# M7 — End-to-end enforcement, restart, authorization, and accessibility negative tests

Status: done, 2026-08-09.

Closes the two test gaps CONTRACT-012 Amendment 1 explicitly flagged, plus
the "restart and authorization negative tests generally" scope item.

## Axe accessibility coverage for the Policy page

Only the Overview page had an automated accessibility check
(`tests/dashboard/app.test.tsx`) before this milestone -- the Policy page
(`policy-control.tsx`, meaningfully redesigned in M6 with new form controls:
rollback, override, six dedicated envelope number inputs) had none.

Added `"renders the Policy page with no automated accessibility violations"`:
navigates to `/policy` via the real sidebar link, stubs `fetch` to reject
(no backend in this test, matching how the page's own `.catch()` already
degrades to "no active policy" rather than throwing), and runs `axe.run()`
with the same `color-contrast` rule disabled as the existing Overview check
(disabled because jsdom cannot compute rendered contrast, not because
contrast is unchecked in principle).

## CSRF-rejection coverage for `/api/v1/policy/*`

Only `/api/v1/settings/telegram` had a dedicated CSRF-rejection test before
this milestone. Added
`"every /api/v1/policy/* mutation route rejects a missing or wrong CSRF
token"`: iterates all six state-mutating policy routes (`draft`, `validate`,
`approve`, `activate`, `rollback`, `codex-override`) with no token and with
an explicitly wrong token, asserting 403 on both for every route. Also
asserts `/api/v1/policy/simulate` -- deliberately CSRF-exempt, a read-only
"what would happen" query per ADR-0003's query/command boundary, gated only
by `requireOwner` -- stays reachable without a token, so the test documents
that boundary instead of accidentally treating it as a bug.

## Authorization negative tests, broadened

Only `/api/v1/dashboard/snapshot` had a cloudflare-mode 401 test before this
milestone. Added
`"cloudflare auth mode rejects every requireOwner route without the
identity header"`: exercises five representative `requireOwner` routes
(snapshot, policy active GET, factory projects POST, policy draft POST,
orchestrator proposals POST) with a valid CSRF token attached but no
Cloudflare identity header, proving a valid CSRF token can never substitute
for owner authentication on any of them -- `requireOwner` and `requireCsrf`
are independent gates in `app.ts`, and this test is the first to prove that
independence across more than one route rather than assuming it generalizes.

## Restart negative test

`src/config.ts` generates a fresh ephemeral CSRF secret per process when
`CSRF_SECRET` is unset (dev/test only; production requires an explicit one)
-- documented in a code comment ("restarts simply invalidate any cached
client token, which is expected and safe") but never actually proven.

Added `"a restart issues a fresh ephemeral CSRF secret that invalidates the
previous process's token"`: starts two independent server processes with no
`CSRF_SECRET` override (simulating two restarts), confirms their generated
secrets differ, then confirms a token minted by the first process is
rejected (403) by the second while the second's own token succeeds (200)
against the same route. This is the first test to actually exercise
process-restart CSRF behavior rather than only asserting it from a single
long-lived process, which is what every other CSRF test in the suite does.

## Test evidence

3 new tests in `tests/control-api.integration.test.ts` (CSRF-matrix,
broadened-authorization, restart), 1 new test in `tests/dashboard/app.test.tsx`
(Policy page axe). Full suite:

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 159
# pass 159
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run typecheck`, and
`scripts/verify-contract.ts CONTRACT-013` all pass.
