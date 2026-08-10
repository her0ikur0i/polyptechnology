# CONTRACT-015 — owner acceptance checklist

Each bullet from the contract's Acceptance section, mapped to what actually
proves it. Anything an owner can check by hand is written as a command they can
run.

## 1. Exactly one provider-routing abstraction and one path-safety guard

**Status: met.**

```bash
ls src/providers 2>&1              # No such file or directory
grep -rn "function safePath\|function safeWorkerPath" src/   # no matches
grep -rln "safeRelativePath" src/  # safe-path.ts + its three callers only
```

`src/providers/**` (registry, router, adapter, types) is gone along with
`src/index.ts`, `src/work/postgres-publication-recorder.ts`, and
`tests/providers.test.ts`. `src/gateway/**` is now the only answer to "how does
this system route to a provider", and `CLAUDE.md` says so in the module map.

Three path guards became one, `src/safe-path.ts`, with each of the three
boundaries keeping its own wrapper and label so they remain independently
reviewable — the prior contract's deliberate-duplication reasoning was honoured
rather than overruled. Evidence: `evidence/M1-…md`, `evidence/M2-…md`.

## 2. The dashboard no longer ships its own source to the browser

**Status: met.**

```bash
npm run dashboard:build
find dist-dashboard -name "*.map"   # 0 files
```

`vite.config.ts` builds with `sourcemap: false`, and the Control API separately
404s any path ending in `.map` before `express.static` sees it, so a build that
re-enables maps elsewhere still cannot leak source through this server. The
1.47 MB map that used to sit beside a 289 kB bundle is gone.

Evidence: `evidence/M3-…md` §1.

## 3. Request floods cannot exhaust the AI budget, and the owner is never locked out

**Status: met.**

Two independent buckets — 300/min for `/api/`, 60/min for the Telegram webhook,
both configurable. `tests/rate-limit.test.ts` proves requests within the
ceiling pass through, that exceeding it returns 429, that an exhausted API
budget leaves both non-API paths and the webhook's own budget untouched, and
that the webhook's ceiling is enforced separately.

The no-lockout half is proven three ways: the default is asserted against the
reply poller's actual 1.5 s interval rather than a hard-coded number; both
ceilings are configurable without a deploy; and `config.ts` enforces a floor of
30/min so a near-zero ceiling cannot be configured at all.

Evidence: `evidence/M3-…md` §2.

## 4. A new `MODEL_POLICY_VERSION` cannot be approved without its canary passing

**Status: met.**

`PostgresPolicyStore.validate()` refuses any draft without a `canary_passed`
record bound to that policy's `policy_sha256`. Four independent fail-closed
paths: no evidence refuses; an empty canary refuses at record time; a partial
pass refuses the whole batch; and evidence is bound to content, so editing a
draft after its canary ran invalidates the proof. A provider-filtered canary run
refuses to record at all.

Owner procedure:

```bash
POLICY_ID=<draft id> POLICY_VERSION=<n> TEST_DATABASE_URL=… \
  node --import tsx scripts/policy-canary.ts
```

then validate through the dashboard. Evidence: `evidence/M4-…md`.

## 5. A dashboard API shape change produces a handled error, not a blank screen

**Status: met.**

All 26 response-returning functions in `src/dashboard/api.ts` now validate at
the boundary; zero unchecked `as` casts remain on a success path. The private
`commandRequest()` helper takes its parser as a **mandatory** parameter, so a
future call site cannot compile without wiring one — the guarantee is
structural, not a convention someone has to remember.

The change immediately surfaced a real stale test fixture (a mock missing
`webhookRegistered`, a field the server always sends), which was fixed by
correcting the fixture rather than loosening the validator.

Evidence: `evidence/M5-…md`.

## 6. `npm run format:check` reports zero warnings repository-wide

**Status: met.**

```bash
npm run format:check   # All matched files use Prettier code style!
```

## 7. A fresh session can orient from `CLAUDE.md`

**Status: met.**

`CLAUDE.md` is new: reading order, the module map, the invariants that must not
be weakened, the delivery discipline, what must not be touched without fresh
approval, and the traps that have already cost this project time.

Most importantly it documents the **zero-skip test invocation** and why it
matters — large parts of the suite skip silently without
`TEST_DATABASE_URL`/`TEST_WORKER_IMAGE`, so a test count means nothing unless
the invocation is named alongside it. That exact failure mode occurred during
this contract and was caught in review.

`docs/RESUME.md` shrank from 273 lines to 131 by dropping four per-contract
milestone tables that duplicated `evidence/*.md`, while keeping everything
recorded nowhere else.

Evidence: `evidence/M7-…md`.

## Gate summary

| Gate                      | Result                                        |
| ------------------------- | --------------------------------------------- |
| Backend suite (zero-skip) | 193 passed, 0 failed, 0 skipped               |
| Dashboard suite           | 38 passed across 5 files                      |
| `npm run typecheck`       | clean                                         |
| `npm run format:check`    | clean repository-wide                         |
| `npm audit`               | 0 vulnerabilities                             |
| `verify-contract.ts`      | structure and scope OK, no out-of-scope paths |
| Dashboard build           | 4 chunks, main 262.99 kB, 0 sourcemaps        |

Baseline entering the contract was 178 backend tests. The count fell to 168 when
M1 removed dead code together with the only tests that exercised it, then rose
to 193 as M2, M3, M4 and M8 added real coverage.

**One caveat the owner should read rather than take on trust.** Bullet 3 above
was recorded as met after M3, and it was not: the independent review in M8 found
that the limiter could be bypassed entirely by changing the case of the request
path, because Express matches routes case-insensitively while the dispatch check
compared case-sensitively. Every M3 test used the canonical lower-case path, so
the suite was green while the protection was absent. It is genuinely met now —
verified by live request against four case variants and covered by a regression
test — but the sequence is recorded here because "a passing gate" and "a working
protection" turned out to be different things once, and may again.
