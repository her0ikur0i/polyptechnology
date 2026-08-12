# M6 — README, security review, close

Date: 2026-08-12. Status: **done.**

## Gates, all green

- Full suite: **414 backend tests, 414 passing, 0 skipped** under the
  standing zero-skip invocation
  (`TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... TEST_SCAFFOLD_GATES=enabled npm test`),
  up from 371 at CONTRACT-017C's close. Dashboard: **38 tests, 38 passing**.
  Dashboard build succeeds.
- `npm run typecheck`: clean.
- `npm run format:check`: clean.
- `npm audit`: 0 vulnerabilities.
- `node --import tsx scripts/verify-contract.ts CONTRACT-017D`: file
  ownership respected.
- `node --import tsx scripts/resume-checkpoint.ts --check`: `docs/RESUME.md`
  current.
- `/security-review`: **no findings.** Full trace on the two paths most
  likely to matter — `PostgresRunFacts.tiersFor()`'s output reaching a
  `parse_mode: "HTML"` Telegram send (escaped by `renderReport()` before
  every send; the underlying `requested_model_id` values are drawn from a
  closed, hardcoded set in `src/gateway/model-policy.ts`, never from
  provider output or owner input) and `reclaimStranded()`'s SQL (fully
  parameterized, horizon validated before the query runs). Confirmed clean.

## README updated

Reflects the escalation chain now proven to reach `claude-sonnet-5`, reports
naming every tier walked, and the `NODE_ENV=production` defect as the third
lesson this pipeline had to learn the hard way.

## What this contract closes

`CONTRACT-017D` — the drill, reproducible and unattended. Every milestone:

- **M0**: a harder brief (`moneybag`) exposed that hard work couldn't land
  inside its attempt budget — and that the real cause was narrower than it
  looked.
- **M1**: the supervisor was killing itself under every Codex call
  (`TasksMax=64` one task short of a single `codex exec`, a watchdog ping
  with no error listener). Fixed; `reclaimStranded()` added as the ledger's
  counterpart to the work engine's `reclaimExpired()`.
- **M2**: a second ceiling sat right next to M1's fix — a $2.00 budget cap
  that could only ever fund 4 of the 6 attempts `maxAttempts` allowed,
  structurally blocking `claude-sonnet-5`. Fixed. Proving the fix honestly
  then surfaced a third, more serious defect: `NODE_ENV=production` silently
  stripped every devDependency from every generated scaffold, so `tsc` never
  existed and four "rejections" were an infrastructure failure wearing a
  verification failure's clothes. Fixed, with a regression test that sets
  the ambient variable explicitly rather than hoping a shell has it.
- **M3**: reports now name every tier a run walked, in order — not just
  whichever attempt cost the most.
- **M4**: two independent clean-database runs (fresh Postgres containers,
  fresh workspaces, throwaway supervisors, no shared state) produced
  identical terminal results.
- **M5**: $15.00 in stranded reservations reconciled with real, re-hashable
  evidence — not an invented SHA. $0.20 left deliberately untouched, pending
  a real check against the provider that actually holds a session for it.

**The chain has now been proven in both directions on real, paid drills**: a
run that exhausts every earlier tier reaching `claude-sonnet-5`, and a run
that accepts on a middle tier without ever needing the last one. Total real
spend across every drill this contract ran: **under $0.03**.

## Push

Single commit for the whole contract, `heroikuroi <heroikuroi@gmail.com>`
with Claude as `Co-Authored-By`, per standing delivery rules. Pushed after
this evidence and the regenerated resume checkpoint.
