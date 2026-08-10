# M9 — Evidence reconciliation, staging redeploy, commit and push

Date: 2026-08-10. Status: **done**.

Executed under the advance authority the owner granted at M0
(`M0-owner-confirmation.md` §2): redeploy, commit and push proceed once every
gate is green, without a further pause. No action here touched public DNS,
production, secrets, or `polyptech-dashboard.service`, all of which remain
outside that grant.

## Final gates

| Gate                      | Result                                        |
| ------------------------- | --------------------------------------------- |
| Backend suite (zero-skip) | 193 passed, 0 failed, 0 skipped               |
| Dashboard suite           | 38 passed across 5 files                      |
| `npm run typecheck`       | clean                                         |
| `npm run format:check`    | clean repository-wide                         |
| `npm audit` (dev + prod)  | 0 vulnerabilities                             |
| `verify-contract.ts`      | structure and scope OK, no out-of-scope paths |
| Dashboard build           | 4 chunks, main 262.99 kB, 0 sourcemaps        |

Measured with the standing zero-skip invocation from `CLAUDE.md`. That
qualification is not decoration: this contract had a milestone report a "187,
186 pass, 1 skipped" run as matching a `0 skipped` baseline, which is exactly
what the invocation exists to prevent.

Test-count trail across the contract: **178 → 168 → 179 → 185 → 187 → 193.**
The dip is M1 removing dead code together with the only tests that exercised it;
every later rise is real coverage added by M2, M3, M4 and M8.

## Staging redeploy

New immutable release
`/opt/polyp-ai-factory/releases/20260810T011359Z-contract015`, built from this
working tree (`tsc` + `vite build`, then `npm ci --omit=dev`), with
`/opt/polyp-ai-factory/current` repointed to it. The previous release
(`20260809T135047Z-contract014-wip`) is left in place, so rollback is a symlink
swap and a restart.

**No migration was applied, because this contract adds none** — the canary gate
in M4 was deliberately built on the existing `policy_events` table precisely to
keep that true, and the contract's stated rollback position ("no data-level
rollback to perform") therefore still holds exactly as written.

Same trust boundary as before: loopback-bound `127.0.0.1:4180`,
`ACCESS_AUTH_MODE=disabled`, no Telegram credentials, and
`polyp-sequence.service` still not running — standing up hardening does not by
itself authorize real, costed provider calls.

### Live verification against the running process

Not integration tests — the real service, over HTTP, after restart. This repo
has been bitten before by a server that passed every integration test and then
refused to boot.

```
GET  /healthz                          200
GET  /                                 200   (SPA)
GET  /assets/FactoryLive-BJPDw5gq.js   200
GET  /assets/FactoryLive-BJPDw5gq.js.map   404
GET  /assets/FactoryLive-BJPDw5gq.js.MAP   404   (case-folded guard, M8 fix)
```

Rate limiting, exercised at the real 300/minute default by sending 305 requests
and then probing:

```
lowercase after flood   429
UPPERCASE after flood   429   (M8's critical bypass, confirmed closed live)
non-API path            200   (never throttled)
```

`find <release>/dist-dashboard -name "*.map"` → **0 files**. The 1.47 MB
sourcemap that shipped with every previous release is gone from the deployed
artifact, not merely from the source tree.

## What this contract changed, in one paragraph

Removed a competing provider abstraction with zero importers, so there is now
one answer to how the system routes to a provider. Collapsed three drifting
copies of the path-traversal guard into one, strengthened it beyond what any of
the three did, and gave it adversarial tests. Stopped publishing the dashboard's
own source to anyone who loads it. Added the request throttle the control plane
never had, twice — once wrong, then correctly after an independent review found
the bypass. Turned the policy canary from a sentence in a checklist into a gate
that fails closed. Put runtime validation on every dashboard API response.
Split the three heavy pages out of the entry bundle. Stopped the stylesheet
claiming a typeface that had never loaded. Wrote `CLAUDE.md` and cut
`docs/RESUME.md` in half.

## Commit

One commit, per the standing pattern, containing every milestone's work and
evidence. Pushed to `main` on `origin` under the M0 grant.
