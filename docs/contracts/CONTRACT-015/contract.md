# CONTRACT-015 — Foundation hardening: retire competing abstractions, unify path safety, close audit findings

Status: complete — M0 through M9 done, all gates green (193 backend tests, 0
skipped; 38 dashboard; zero `format:check` warnings; zero `npm audit`
findings), redeployed to private staging and verified live. Milestone evidence
in `evidence/`; owner acceptance mapping in `acceptance-checklist.md`; the audit
that motivated the contract in `audit-2026-08-09.md`.

## Objective

Close the concrete defects found by the 2026-08-09 repository-wide audit
(`docs/contracts/CONTRACT-015/audit-2026-08-09.md`) before any product work
is layered on top of them. This contract deliberately ships no new user-
facing feature: it removes a whole competing abstraction that nothing uses,
collapses three separate copies of a path-traversal guard into one, stops
publishing the dashboard's full source to anyone who loads it, and gives
the control plane the request throttle it has never had. Every later
contract in the roadmap (`docs/product/roadmap-2026H2.md`) builds on these
files, so fixing them first is cheaper than fixing them underneath finished
features.

## Depends on

CONTRACT-013 (accepted): the private staging instance (`polyp-control-api.service`,
loopback 4180) reused verbatim, the `AiGateway`/`RuntimePolicy` reconciliation,
and the CSRF/auth patterns in `src/control-api/**`. CONTRACT-014 (accepted,
`f58a649`, pushed): the conversation workspace whose dashboard API boundary
M5 hardens, and `src/deterministic-id.ts`, the deduplication precedent M2
follows.

## Scope

- **Retire dead and competing abstractions.** `src/providers/**` (registry,
  router, adapter, types) has zero importers outside itself and duplicates
  the responsibility that `src/gateway/**` actually performs in production —
  it is not merely unused code, it is a second, plausible-looking answer to
  "how does this system route to a provider", and a reader has no way to
  tell which one is live. `src/index.ts` and
  `src/work/postgres-publication-recorder.ts` likewise have zero importers.
  All three were queued by CONTRACT-013 M11 as outside that contract's
  ownership; they are inside this one's. `tests/providers.test.ts` (287
  lines) goes with them: it is the only consumer of `src/providers/**`, and
  a test whose sole subject is unreachable code protects nothing. Removing
  289 lines of source and 287 lines of test drops the suite from 178 tests;
  the evidence must state the new total plainly rather than let a smaller
  number read as a regression.
- **Unify path safety.** Three independent guards exist:
  `safeWorkerPath()` (`src/worker/planner.ts:4`), and two separate
  `safePath()` implementations (`src/work/git-publication.ts:16`,
  `src/operations/patch-scope.ts:9`). These are the boundary that stops an
  AI-authored diff from writing outside its declared scope. Three copies
  means three chances to drift and a fix that reaches only one call site.
  Collapse into one module with adversarial tests. `docs/RESUME.md`
  recorded this as a two-way duplication; it is three-way.
- **Stop publishing dashboard sources.** `vite build` emits
  `dist-dashboard/assets/*.js.map` (1.47 MB) and the Control API serves that
  directory, so the entire dashboard source is readable by anyone who can
  reach the dashboard. Harmless on a loopback-bound staging instance;
  unacceptable the moment the public hostname cutover happens.
- **Request rate limiting.** There is none anywhere in `src/` — verified by
  search, and independently acknowledged as deferred by CONTRACT-013 M8 on
  the grounds that staging is private. This system spends real money per
  request through `AiGateway`, so the throttle is a budget control as much
  as an availability one. Applied at the Control API boundary, with the
  Telegram webhook route treated separately (it is authenticated by
  `secret_token`, not by owner session).
- **Wire the policy canary.** `scripts/policy-canary.ts` has zero references
  from `src/` and must currently be remembered and run by hand before any
  new `MODEL_POLICY_VERSION` is approved. Wire it into
  `PostgresPolicyStore.validate()` so an unproven policy version fails
  closed instead of relying on operator memory.
- **Validate API responses at the dashboard boundary.** `src/dashboard/api.ts`
  is 578 lines and `src/dashboard/validation.ts` exports one function; most
  responses reach React as unchecked `as` casts, so a server-side shape
  change surfaces as a render crash rather than a handled error.
- **Eliminate silent failure.** Five `catch {}` blocks discard their error
  entirely. Each either gets a real handler or an explicit comment
  justifying the swallow, matching the pattern already used deliberately in
  `conversation-workspace.tsx`'s reply poller.
- **Dashboard build hygiene.** All 11 routes are eagerly bundled into a
  single 289 KB chunk with zero `lazy()` boundaries. `styles.css:2` declares
  `"DM Sans"` which is never loaded by any `@font-face` or link, so the
  dashboard has always silently rendered in `system-ui` — the declared
  typography has never once appeared. Fix the fallback honestly: load the
  face or stop naming it. The full design-system replacement is CONTRACT-017,
  not this contract.
- **`CLAUDE.md` and documentation consolidation.** The repository has
  `AGENTS.md` but no `CLAUDE.md`. `docs/RESUME.md` has grown past 200 lines
  and now restates what per-contract `evidence/*.md` files already record.
- **Negative tests and a security re-review** of everything this contract
  changes — specifically the unified path guard (adversarial inputs) and the
  rate limiter (that it cannot be tripped into locking the owner out).
- Evidence reconciliation, exactly one commit, and push.

## Out of scope

Chat streaming, markdown rendering, and every other conversation-workspace
improvement (CONTRACT-016). The Factory Live event producer and the correction
of release criterion 8's status (CONTRACT-017) — the audit found that view has
no server at all, which is a feature to build, not a defect to patch, and it
must not be smuggled into a hardening contract. The design-system replacement,
light mode, token architecture, and the `/infrastructure` and `/agents`
placeholder pages (CONTRACT-018). Multi-stack project generation
(CONTRACT-019). Per-project domains, reverse-proxy routing, and the
detach/export flow (CONTRACT-020). Telegram surface expansion beyond what
already exists (CONTRACT-016).
Full JWT verification of the Cloudflare Access header — still deliberately
deferred, tracked against CONTRACT-019's cutover gate, not reopened here.
Any DNS, public hostname, Cloudflare, or production-promotion action. Any
change to the orphaned `polyptech-dashboard.service`. Reconciling
CONTRACT-008's `outcome_unknown` ledger attempt
(`66717047-593d-4976-b133-0a04d475e341`) — it matters only to whichever
database becomes production, which no contract has yet designated.

## Milestones

0. M0: **owner confirmation gate — the only checkpoint, and it runs first.**
   Placed at the start at the owner's explicit direction (2026-08-09), so
   execution afterwards is uninterrupted. Everything requiring owner
   authority is settled here: the scope below including the deletions in
   M1, the correction to release criterion 8's status in
   `docs/contracts/CONTRACT-010/acceptance-matrix.md`, advance approval to
   redeploy the private staging instance, and advance approval to commit
   and push the single resulting commit once every gate is green. No
   milestone after this one pauses for owner input; if any later milestone
   discovers work needing an authority this gate did not grant, that work
   is deferred to the next contract rather than interrupting this one.
1. M1: retire `src/providers/**`, `src/index.ts`, and
   `src/work/postgres-publication-recorder.ts`; prove by full-suite pass
   that nothing depended on them.
2. M2: unify `safeWorkerPath()` and both `safePath()` implementations into
   one module with adversarial traversal/encoding/symlink tests.
3. M3: stop emitting and serving dashboard sourcemaps; add Control API
   rate limiting that cannot lock out the owner. (The third item as drafted —
   "replace the five silent `catch {}` blocks" — was withdrawn during
   execution: re-checking found zero empty catch bodies, and the audit finding
   that prompted it was a grep artefact. See `evidence/M3-…md` §3.)
4. M4: wire `scripts/policy-canary.ts` into `PostgresPolicyStore.validate()`
   so an unproven `MODEL_POLICY_VERSION` fails closed.
5. M5: runtime response validation across the `src/dashboard/api.ts`
   boundary, with a handled error path instead of a render crash.
6. M6: dashboard build hygiene — route-level code splitting, and an honest
   resolution of the never-loaded `"DM Sans"` declaration.
7. M7: `CLAUDE.md`, and consolidation of `docs/RESUME.md` against the
   per-contract evidence it now duplicates.
8. M8: negative tests and independent security re-review of the unified
   path guard and the rate limiter; remediation of whatever it finds.
9. M9: evidence reconciliation, private-staging redeploy, exactly one
   commit, and the push — all executed under the authority M0 granted in
   advance, with no further pause.

## Gates

- The full backend suite, dashboard suite, `npm run typecheck`,
  `npm run format:check`, `npm audit`, and the secret-pattern scan all pass
  with zero regressions against the CONTRACT-014 baseline (178 backend
  tests, 20 dashboard tests) — measured with the standing zero-skip
  invocation in `docs/RESUME.md`, not a default `npm test` that silently
  skips database and Docker suites.
- Deleting `src/providers/**` changes no runtime behaviour: proven by the
  suite passing unchanged, not by inspection alone.
- The unified path guard rejects every adversarial input the three previous
  implementations rejected, plus the cases only one of them caught — the
  union of their protections, never the intersection.
- `dist-dashboard/` contains no `.map` file after a production build, and
  the Control API serves no sourcemap.
- Rate limiting rejects abusive request volume while leaving normal owner
  use, the dashboard's snapshot polling, and the reply poller unaffected —
  proven by test, not by assumption.
- An unproven `MODEL_POLICY_VERSION` cannot be activated once M4 lands.
- `scripts/verify-contract.ts CONTRACT-015` reports no out-of-scope dirty
  paths.

## Acceptance

- A reader opening the repository finds exactly one provider-routing
  abstraction and one path-safety guard, with no plausible-looking
  alternative to mistake for the live one.
- The dashboard no longer ships its own source to the browser.
- The Control API survives a request flood without exhausting the AI
  budget, and the owner is never locked out by that protection.
- A new `MODEL_POLICY_VERSION` cannot be approved without its canary
  passing.
- A dashboard API shape change produces a handled error, not a blank
  screen.
- `npm run format:check` reports zero warnings across the entire
  repository.
- A fresh session can orient from `CLAUDE.md` without reading all fourteen
  prior contracts.

## Rollback

Revert the commit. This contract adds no migration and changes no schema,
so there is no data-level rollback to perform. Deleted files return with
the revert. The rate limiter and the policy-canary wiring are the only
behavioural additions: both fail toward the pre-contract behaviour when
disabled by configuration, so a partial rollback via configuration is
available without a code revert. The redeployed staging instance can be
stopped and the previous release symlink restored, the same procedure
CONTRACT-013 M9 proved live.

## File ownership

- `docs/contracts/CONTRACT-015/**`
- `docs/product/**`
- `docs/architecture/**`
- `docs/security/**`
- `docs/RESUME.md`
- `CLAUDE.md`
- `src/providers/**`
- `src/index.ts`
- `src/work/**`
- `src/worker/**`
- `src/operations/**`
- `src/control-api/**`
- `src/dashboard/**`
- `src/policy/**`
- `src/gateway/**`
- `src/safe-path.ts`
- `src/config.ts`
- `scripts/**`
- `tests/**`
- `vite.config.ts`
- `package.json`
- `package-lock.json`

M8's remediation may extend to any path this contract already owns. Unlike
CONTRACT-013 M11 and CONTRACT-014 M11, no milestone here takes a temporary
`**` formatting exception: the repository is already at zero
`format:check` warnings, so any reformatting outside this list would be
unexplained.
