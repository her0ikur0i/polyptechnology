# M9 — Immutable private staging deployment, activation, health, rollback proof

Status: done, 2026-08-09. Owner-authority checkpoint: proceeded only after
explicit direction ("saya mengikuti rekomendasi anda") in response to two
concrete open questions (private-access mechanism, real-secret sourcing).

## Scope decisions made under that delegation

1. **Access mechanism: network-level, not Cloudflare Access.** The service
   binds to `127.0.0.1` only and publishes no port beyond loopback. Intended
   real access path: an SSH tunnel to this host
   (`ssh -L 4180:127.0.0.1:4180 <host>`, then browse
   `http://127.0.0.1:4180` locally). Setting up an actual Cloudflare Access
   application/DNS record was deliberately not done -- `contract.md` states
   "the public hostname cutover remains a separate, explicit approval," and
   a Cloudflare Access app requires a hostname decision that's properly a
   separate approval, not bundled into this milestone.
2. **`ACCESS_AUTH_MODE=disabled`, `NODE_ENV=development`.** `ACCESS_AUTH_MODE=cloudflare`
   requires `NODE_ENV=production`, which in turn requires real Telegram
   credentials and a real Cloudflare Access setup (deferred per decision 1)
   -- forcing that combination here would either fail to start or require
   fabricating credentials with no real Cloudflare Access in front of them
   to justify trusting the identity header at all. The loopback bind (M8's
   fix, now exercised for real) is the actual trust boundary for this
   deployment, matching what `ACCESS_AUTH_MODE=cloudflare` would enforce
   anyway once real Access exists.
3. **`CSRF_SECRET` left unset (ephemeral, per-process).** No owner input
   needed -- `config.ts` generates one automatically outside production, and
   restarts invalidating cached tokens is already-documented, expected
   behavior (the dashboard always fetches a fresh token via the snapshot
   response on load).
4. **The background task-execution supervisor (`sequence-main.ts`) was
   deliberately NOT installed or started.** It wires real `DeepSeekAdapter`/
   `CodexCliAdapter`/`ClaudeCliAdapter` against real provider credentials
   (`src/orchestrator/sequence-main.ts`) and would begin executing any
   queued task with real, potentially costly API calls. `POST
/api/v1/factory/projects/:id/generate` only _queues_ a task -- it never
   executes inline (M5 evidence) -- so the Control API alone never spends
   money or calls a real provider. Running the supervisor is a materially
   different, costlier decision than "stand up a private dashboard for
   acceptance testing" and was left for a separate, explicit approval,
   consistent with CONTRACT-010 Owner Action Bundle's own separation of
   "release activation" from "Telegram live connection" (a paid probe).

## What was installed

- System user `polyp-factory` (system account, no login shell, no home
  directory content).
- Immutable release layout: `/opt/polyp-ai-factory/releases/<timestamp>-contract013-wip/`
  (built from the current uncommitted CONTRACT-013 working tree -- labeled
  `-wip`, not a commit SHA, specifically so the release directory name never
  implies it matches a committed SHA that doesn't yet contain this code) with
  production-only `node_modules` (`npm ci --omit=dev`), root-owned,
  `/opt/polyp-ai-factory/current` symlinked to it.
- A new, persistent staging Postgres: `polyp-staging-pg` (Docker, named
  volume `polyp-staging-pg-data` for data survival across container
  restarts, published as `127.0.0.1:55434:5432` -- loopback only, distinct
  from both `polyp-contract006-pg` (an older contract's database, untouched)
  and `polyp-contract011-pg` (the disposable test database, untouched)).
  All 10 migrations applied.
- `/etc/polyp-ai-factory/control-api.env` (root:root, `0600`): real
  generated staging Postgres password, `HOST=127.0.0.1`, `PORT=4180`,
  `PROJECT_WORKSPACES_ROOT=/var/lib/polyp-ai-factory/project-workspaces`.
- `deploy/systemd/polyp-control-api.service` (new, added to the repo):
  mirrors the existing `polyp-sequence.service`'s hardening profile
  (`ProtectSystem=strict`, `NoNewPrivileges`, `MemoryDenyWriteExecute`,
  capability bounding set cleared, restricted address families, `MemoryMax=512M`,
  `TasksMax=64`, dedicated `StateDirectory`/`LogsDirectory`). Installed to
  `/etc/systemd/system/`, enabled, started.

## A real bug found and fixed by actually booting the compiled server

`src/control-api/server.ts` resolved `dist-dashboard/`'s path as two levels
up from `import.meta.url`. That is correct in dev
(`src/control-api/server.ts` is two levels below the repo root) but wrong
once compiled: `dist/src/control-api/server.js` is only two levels above
`dist/`, not the repo root, because `tsc` mirrors the full `src/...` path
under `dist/`. The bug did not crash -- it silently downgraded to
`servingDashboard:false`, so the API worked but the dashboard SPA was never
served. Only caught by starting the real compiled process on this staging
host, exactly the CONTRACT-012 lesson ("run the real server as a live
process at least once per milestone, don't rely on integration tests
alone"): the existing SPA-serving integration test injects `dashboardDistPath`
directly as a dependency override and never exercises this resolution path
at all.

Fixed by resolving from `process.cwd()` instead: both `npm start` (repo
root) and the systemd unit (`WorkingDirectory=<release>`) run with cwd set
to the project/release root, which doesn't have the src-vs-dist depth
mismatch `import.meta.url` math did. New regression test:
`tests/server-boot.test.ts` -- boots the real `tsx`-run server as a child
process and asserts `servingDashboard: true` in its own ready-event log
line, so this class of bug can't silently regress again.

## Health verification (real, live)

```
$ curl http://127.0.0.1:4180/                                    -> 200 (SPA)
$ curl http://127.0.0.1:4180/api/v1/dashboard/snapshot            -> 200, real csrfToken,
                                                                       0 projects/contracts/attempts (fresh staging DB)
$ systemd-analyze security polyp-control-api.service              -> exposure 3.9 OK (matches polyp-sequence.service's baseline)
$ cat /proc/<pid>/status | grep -E '^(Uid|Gid)'                   -> 999/987 (polyp-factory, not root)
```

## Rollback proof (real, live)

```
$ systemctl stop polyp-control-api.service
$ systemctl is-active polyp-control-api.service                   -> inactive
$ ss -ltn | grep 4180                                              -> (nothing -- port closed)
$ curl http://127.0.0.1:4180/api/v1/dashboard/snapshot --max-time 2 -> connection refused
$ systemctl start polyp-control-api.service
$ systemctl is-active polyp-control-api.service                   -> active
$ curl http://127.0.0.1:4180/api/v1/dashboard/snapshot            -> 200
```

Stop leaves no orphaned process or listening port (clean host-state
reversion); start brings health back within 2 seconds. There is no prior
release to roll back _to_ yet (this is the first install) -- this proof
demonstrates the operational stop/start procedure itself is safe and
reversible, which is what an initial activation can actually prove.

The pre-existing orphaned `polyptech-dashboard.service` (port 4173,
`dash.surachmancenter.com`) was confirmed still active and untouched
throughout -- this milestone's server runs on a distinct port (4180) with
no shared state.

## Test evidence

`tests/server-boot.test.ts` (1 new test, boots the real server process).
Full suite:

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 164
# pass 164
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run typecheck`, and
`scripts/verify-contract.ts CONTRACT-013` all pass.

## Access for the owner acceptance pass (M10)

```
ssh -L 4180:127.0.0.1:4180 <this-host>
# then browse http://127.0.0.1:4180 locally
```

No Telegram approvals are configured on this staging instance (no bot
token supplied, per decision 3 in Scope decisions -- absence is fail-closed,
the webhook route simply does not register). The background task-execution
supervisor is not running (decision 4) -- `POST .../generate` will queue a
task that stays `queued` until a supervisor is explicitly started with real
provider credentials, a separate decision.
