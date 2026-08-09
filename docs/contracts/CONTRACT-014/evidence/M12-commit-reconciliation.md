# M12 — Evidence reconciliation, one commit, push

Status: gates green and reconciled 2026-08-09. Commit staged; **push
withheld pending the owner's explicit "push it" confirmation**, per the
standing rule established across CONTRACT-011/012/013 (never push
without that exact go-ahead, each time, no matter how many gates already
passed).

## Evidence reconciliation

All 11 evidence files for M1-M11 exist and are internally consistent
with what actually happened, cross-checked against `git status`/`git
diff` and live re-verification, not just re-read for prose consistency:

- `M1-conversation-routes.md` through `M11-code-quality-cleanup.md`: each
  file's stated test count matches the suite size at the time it was
  written -- historical snapshots, intentionally not rewritten to the
  final count, matching how prior contracts' evidence files were left
  after closing.
- `docs/contracts/CONTRACT-014/acceptance-checklist.md` (M10's
  deliverable) still accurately reflects the M10-redeployed staging
  instance's real state (no Telegram bot token, no background
  supervisor running, migrations 0011-0013 applied) -- re-verified live
  moments before writing this file.
- `docs/RESUME.md` rewritten: "Active objective" no longer implies
  CONTRACT-014 is upcoming work -- now states the real current state
  (all 12 milestones done, commit staged, push pending explicit
  confirmation), adds the new CONTRACT-014 status table matching the
  existing per-contract format, and fixes a stale line left over from
  before CONTRACT-013 was committed (`"Not yet committed -- working
tree still has all of CONTRACT-013's changes uncommitted"`, which
  directly contradicted that same section's own `"status: closed
(57facca)"` heading above it -- a pre-existing inconsistency in the
  file, not something this contract introduced, fixed while touching
  this file anyway since leaving a known-false line in a document whose
  entire purpose is "the durable summary a fresh session trusts" would
  be worse than the small scope stretch of fixing it).
- `docs/security/CONTRACT-014-M9-review.md` and this contract's other
  evidence files' file:line citations spot-checked against the current
  working tree -- all still accurate (no post-review edits moved the
  cited lines).

## What the single commit will contain

Every file CONTRACT-014 M1-M12 touched: conversation/message routes and
idea-state project bootstrap (M1), assistant replies through the real
`AiGateway` as a background task (M2), file upload wired to the
attachment state machine (M3), the chat UI that fully replaces the old
blueprint form -- `factory-control.tsx` deleted (M4), narrative brief ->
proposal -> owner approval inside the conversation UI (M5), AI-driven
blueprint translation validated through the pre-existing
`parseBlueprint()` gate (M6), session management: rename/archive/search
plus a project picker (M7), the negative-test suite and the stray-NUL
-byte file-corruption fix it surfaced (M8), the independent security
review (M9), the M10 staging redeploy plus its real
`ATTACHMENT_STORAGE_ROOT`/`ReadWritePaths` gap fix, M11's
`deterministicUuid()` deduplication into `src/deterministic-id.ts`, and
this reconciliation's `docs/RESUME.md` update. Plus every CONTRACT-014
evidence file, `docs/contracts/CONTRACT-014/contract.md`, and the three
new migrations (0011-0013).

Deliberately **not** included in any commit, ever, from this session:
the M10 staging redeploy's host-level artifacts (`/opt/polyp-ai-factory/**`,
`/etc/polyp-ai-factory/control-api.env`, the new release directory, the
migrations as applied to `polyp-staging-pg`) -- those are real
infrastructure state outside this git repository, not repository
content. The systemd unit _definition_
(`deploy/systemd/polyp-control-api.service`) was already tracked before
this contract and needed no changes; the installed copy at
`/etc/systemd/system/` is not something git tracks.

## Final full gate run (immediately before commit)

```
$ npm run typecheck                    # clean
$ TEST_DATABASE_URL=... npm test
# tests 178, pass 177, fail 0, skipped 1 (pre-existing, unrelated)
$ npm run dashboard:test               # 20/20 pass
$ npm run dashboard:build              # succeeds
$ npm run format:check                 # zero warnings, repository-wide
$ npm audit --omit=dev                 # 0 vulnerabilities
$ git grep -nE '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|sk-[A-Za-z0-9_-]{20,})'
# no matches
$ git diff --check HEAD                # no whitespace errors
$ scripts/verify-contract.ts CONTRACT-014
# Contract CONTRACT-014 structure and scope: OK -- no out-of-scope dirty
# paths (src/deterministic-id.ts, the one new top-level module M11 added,
# was added to contract.md's file-ownership list in the same milestone
# that created it)
```

## Push

**Withheld.** Will push to `main` on `origin`
(`https://github.com/her0ikur0i/polyptechnology.git`) only after the
owner says "push it" for this specific commit, matching the exact
pattern followed for CONTRACT-011 (`a564bf8`), CONTRACT-012 (`4342ca2`),
and CONTRACT-013 (`57facca`).
