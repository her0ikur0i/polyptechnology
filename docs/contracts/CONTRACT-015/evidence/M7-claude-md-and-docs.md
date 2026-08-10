# M7 — `CLAUDE.md` and documentation consolidation

Date: 2026-08-09. Status: **done**.

## `CLAUDE.md` — new, 130 lines

The repository had `AGENTS.md` (operating policy) and `docs/RESUME.md` (state)
but nothing that told a fresh session how the system is actually shaped or
where the traps are. Fourteen contracts of hard-won knowledge lived only in
`evidence/*.md` files nobody reads before starting.

What it covers, chosen by asking what a fresh session gets wrong without it:

- reading order, and the instruction to check `git log` before trusting any of
  it;
- **the zero-skip test invocation**, with the reason it matters: large parts of
  the suite are gated behind `{ skip: databaseUrl === undefined }` and
  `{ skip: !dockerAvailable }`, so a bare `npm test` passes while testing very
  little. A test count without its invocation is meaningless;
- a module map — which directory owns what, and explicitly that `src/gateway/**`
  is the live provider path (the reason the competing `src/providers/**` was
  removed in M1);
- the invariants that must not be weakened: untrusted model output, the single
  path guard, the canary gate, fail-closed configuration, no secrets in argv,
  cheapest-viable-tier-first escalation;
- the delivery discipline including M0-first confirmation;
- what must not be touched without fresh owner approval;
- **traps that have already cost time**, each one a real incident rather than
  generic advice: Express 5 rejecting a bare `"*"` route at startup with no
  integration test catching it; Factory Live's suite being green against a
  fixture while its server does not exist; Prettier as a mechanical
  repository-wide gate; and test counts legitimately falling when dead code and
  its tests are removed together.

## `docs/RESUME.md` — 273 lines to 131

The file had accumulated full milestone tables for CONTRACT-011 through 014,
restating what each contract's own `evidence/*.md` already records in more
detail. That duplication is how two sources of truth drift.

Removed: the four per-contract milestone tables, replaced by a five-row index
giving commit and subject, with the statement that per-milestone detail lives in
`evidence/*.md` and that this file deliberately no longer restates it.

Kept, because none of it is recorded anywhere else: the standing zero-skip test
invocation and why `TEST_WORKER_IMAGE` is deliberate; the current owner
constraints; the live known issues; and the container inventory distinguishing
the disposable test database from the persistent staging one.

Added: the advance-authority grant and its explicit limits, the
confirmations-at-the-front rule, the host resource ceiling, and the Factory Live
finding — which belongs in known issues precisely because a green suite hides
it.

One correction was made in place rather than deferred: the entry claiming
`scripts/policy-canary.ts` was "not yet wired into `PostgresPolicyStore.validate()`.
Run it by hand" became false the moment M4 landed, and a resume checkpoint that
tells the next session to rely on memory for a safety check is worse than no
entry at all.

## Not done here

`docs/operations/**` is outside this contract's File ownership. It was checked
rather than assumed: `grep` for `canary` across `docs/operations/*.md` found the
term only in `telegram-approvals.md`, in an unrelated sense (a Telegram
connectivity probe). No operations document is made stale by M4, so no ownership
amendment was needed.

## Verification

`npm run format:check` clean repository-wide. No code changed in this milestone,
so the suite is unaffected; the gate figures stand from M4 at 187 tests, 187
passing, 0 skipped.
