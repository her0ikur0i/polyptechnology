# M3 — Build and serve hardening

Date: 2026-08-09. Status: **done**.

## 1. Dashboard sourcemaps are no longer built or served

`vite.config.ts` had `sourcemap: true`, and `src/control-api/app.ts` serves
`dist-dashboard/` as the SPA. The result was a 1.47 MB
`index-9XRs13dx.js.map` — the dashboard's complete original source — readable
by anyone who could load the page, against a 289 KB bundle.

Two changes, deliberately independent:

- `vite.config.ts` now builds with `sourcemap: false`.
- `src/control-api/app.ts` refuses any request path ending in `.map` with a 404
  **before** `express.static` sees it, so a build that re-enables map emission
  somewhere else still cannot leak source through this server.

Verified by rebuilding:

```
dist-dashboard/index.html                 0.44 kB
dist-dashboard/assets/index-DMNMzCnS.css 10.39 kB
dist-dashboard/assets/index-9XRs13dx.js 289.55 kB
```

`find dist-dashboard -name "*.map"` → **0 files**.

## 2. Request throttling

There was none anywhere in `src/`. Every Control API request can reach
`AiGateway`, which spends real money; `src/gateway/postgres-ledger.ts` caps
spend per contract scope but nothing capped request volume, so a flood could
burn budget and CPU right up to that cap.

`express-rate-limit@8.6.2` — an established library rather than a hand-rolled
counter, per the project's stated principle. `npm audit`: 0 vulnerabilities.

Two independent buckets:

| Bucket  | Default   | Env var                         | Applies to                            |
| ------- | --------- | ------------------------------- | ------------------------------------- |
| API     | 300 / min | `API_RATE_LIMIT_PER_MINUTE`     | every `/api/` path except the webhook |
| Webhook | 60 / min  | `WEBHOOK_RATE_LIMIT_PER_MINUTE` | `/api/v1/telegram/webhook` only       |

They are separate because both arrive through the same tunnel and therefore
often share a client address. Inbound Telegram traffic must not be able to
exhaust the owner's allowance, nor the owner's dashboard use the webhook's. The
webhook is also the tighter of the two, because it authenticates by
`secret_token` rather than by owner session.

Dispatch is explicit (`req.path.startsWith("/api/")`) rather than
`app.use("/api/", …)`, so matching is on the full path and cannot be confused
by mount-path stripping. Static assets and the SPA fallback are never
throttled.

### The gate this contract set: it must not lock the owner out

The dashboard's busiest pattern is the reply poller in
`src/dashboard/conversation-workspace.tsx`, at 1.5 s intervals — about 40
requests a minute while an assistant reply is pending. The default ceiling is
300, more than seven times that.

Three separate protections against the throttle becoming the outage:

1. the default is far above real usage, asserted in test against the poller's
   own interval rather than against a hard-coded number;
2. both ceilings are configurable, so raising one never requires a code change
   or a deploy;
3. `config.ts` enforces a **floor of 30** requests/minute — a ceiling that can
   be set near zero is a lockout waiting to happen, and it is now impossible to
   configure one.

That floor caught a real mistake during this milestone: the first version of
the test configured a ceiling of 5 and was rejected by the validator. The test
was wrong, not the code.

### Verification

`tests/rate-limit.test.ts` — 6 tests:

- requests within the ceiling pass through to the rest of the stack; only those
  beyond it get 429 (asserted as "not throttled" rather than on a specific
  downstream status, so the test measures the throttle and not `requireOwner`);
- an exhausted API budget leaves non-API paths unaffected;
- an exhausted API budget leaves the webhook's budget intact, and vice versa;
- the webhook's own ceiling is enforced independently;
- the default clears the reply poller's rate by more than 5×;
- ceilings are configurable, and `0` / non-numeric values are refused.

## 3. Silent `catch {}` blocks — the finding was withdrawn, not fixed

The audit claimed five. **There are none.** The original count came from a grep
whose pattern matched `catch {` at end of line — a parameterless catch, an
ordinary TypeScript idiom — rather than an empty catch body.

Re-checked with a search for `catch (…) { }` with an empty body across every
`.ts`/`.tsx` file under `src/`: zero matches. All eleven parameterless catches
have real bodies — they throw, return a typed failure, `continue`, set
component state, or carry an explanatory comment for a deliberate tolerance.

The finding is struck through in `audit-2026-08-09.md` with the reason, rather
than deleted. An audit that quietly removes its own mistakes is not one this
project's evidence discipline can rely on.

## Gates

```
# tests 185
# pass 185
# fail 0
# skipped 0
# duration_ms 63884.3
```

185 = 179 after M2 + 6 new. Dashboard suite: 5 files, 20 tests, passing.
`npm run typecheck` clean. `npm run format:check` clean repository-wide.
`npm audit`: 0 vulnerabilities after adding the dependency.
