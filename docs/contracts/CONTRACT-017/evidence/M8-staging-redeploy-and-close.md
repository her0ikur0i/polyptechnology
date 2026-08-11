# M8 — Staging configuration, redeploy, reconciliation, close

Date: 2026-08-11. Status: **done**.

## Staging configuration

Migration `0015_telegram_update_offset.sql` was expected to be applied here, at
M8. It was already applied — it went to `polyp-staging-pg` during the M3/M4
live drills, because the poller cannot run without
`telegram_settings.update_offset`. `docs/RESUME.md` claimed the opposite until
this milestone and has been corrected.

Verified rather than assumed:

```
$ psql "$DATABASE_URL" -t -c "select column_name from information_schema.columns
   where table_name='telegram_settings' and column_name='update_offset';"
 update_offset
```

Worth recording for whoever promotes this to production: **there is no
migrations ledger table in either database.** "Applied" is established by
inspecting the schema, which is exactly how this discrepancy survived four
milestones. Naming it here rather than fixing it — a schema-version table is a
change to how every future deployment works, not an M8 footnote.

No other staging configuration changed. Telegram credentials stay in
`/root/.config/polyp/provider-secrets.env`, read by the sequence unit;
`ASSISTANT_TOOLS=enabled` in `/etc/polyp-ai-factory/sequence.env` is unchanged
from Amendment 1. No webhook is registered, because this contract polls.

## Redeploy

Release `20260811T005723Z-contract017-final`, built from this working tree
(`tsc` + `vite build`), `node_modules` hard-linked from the previous release
since `package.json` and `package-lock.json` are untouched by this contract.
`/opt/polyp-ai-factory/current` repointed; **both** services restarted, since
they share that symlink:

```
$ systemctl is-active polyp-sequence.service polyp-control-api.service
active
active
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:4180/                      → 200
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:4180/api/v1/dashboard/snapshot → 200
{"event":"sequence.notifier.warmup","ok":true,"detail":"notification transport reachable"}
```

Four intermediate releases were cut during this session and are kept on disk:
`…-commands` (M6), `…-retrysweep`, `…-failurelog`, `…-final`. Rollback is
repointing the symlink and restarting.

Live drill against the deployed release, all nine command paths delivered to
the owner's chat:

```
/help 830ms · /status 416ms · /runs 390ms · /approvals 390ms · /budget 381ms
/status@PolypTech_bot 384ms · /status --all please 384ms
/deploy production now 767ms (refused) · /stat 381ms (refused)
```

## Gates

| Gate                                         | Result                                |
| -------------------------------------------- | ------------------------------------- |
| Backend suite, standing zero-skip invocation | **332 tests, 332 passing, 0 skipped** |
| Dashboard suite                              | 38 passing, 5 files                   |
| Dashboard build                              | clean                                 |
| `npm run typecheck`                          | clean                                 |
| `npm run format:check`                       | clean                                 |
| `npm audit`                                  | 0 vulnerabilities                     |
| `verify-contract.ts CONTRACT-017`            | structure and scope OK                |
| `resume-checkpoint.ts --check`               | current                               |

**332, up from 276** at the start of this session. The difference, accounted
for rather than asserted: `resume-checkpoint` 17, `telegram-command-facts` 10,
`telegram-conversation-handler` 10, `retry-sweep` 3, `proposal-gate` 3,
`telegram-poller` +2, and 11 subtests reported individually that the earlier
count did not separate.

The suite was run **four consecutive times** before this was written, because
getting there took work.

## The suite was flaky, and that was this contract's doing

The retry sweep changed a global property: due `retry_wait` tasks are now
promoted back to `queued` at the top of every `runOne()`. Five suites turned
out to depend on the shared test database holding **no eligible work but their
own** — an assumption that had always been fragile (there is a comment in
`control-api.integration.test.ts` noting the same hazard) and that the sweep
broke by reliably producing extra eligible work.

Failures were intermittent, roughly one run in three, each time a different
suite asserting against a task id it had never created. That is precisely the
shape of flake a team learns to re-run instead of fix, so it was fixed:

- `tests/run-own-task.ts` — a shared helper that drives a supervisor until it
  reaches _this_ test's task. Applied in `generation-pipeline`,
  `blueprint-translation`, `conversation-reply` (×2) and
  `ai-patch-executor-integration` (×2).
- `operations-postgres` asserted that a rebuilt supervisor returns `undefined`
  — that is, that the entire database was idle. Narrowed to its real intent: a
  completed task must not be run a second time.
- `postgres-work` raced the sweep between forcing `next_attempt_at` and
  promoting the task itself. It now accepts that the sweep may have won.
- `retry-sweep`'s own tests assert `not retry_wait` rather than exactly
  `queued`: once promoted, a task is ordinary eligible work and another suite
  may legitimately finish it first. Pinning the next state would assert that
  nothing else in the system is working.

One production change came out of this: `promoteDueRetries()` now uses the same
eligibility join as the lease query (active contract, active milestone). Waking
a retry whose contract is cancelled only creates work the next lease fails —
churn that looks like progress.

## Spend

**$0.87 total spent** across six budget scopes, up from $0.77 at the start of
the session — roughly **$0.10** for everything here, dominated by the two live
conversation drills. Nine command drills cost nothing: commands are answered
from Postgres with no model in the loop.

**$0.60 remains reserved and unreleased** by the three `outcome_unknown`
attempts described in `evidence/retry-sweep.md`. Unchanged by this milestone
and deliberately so.

## What this contract leaves behind, by name

Nothing silent. Each of these is in `docs/RESUME.md` under known issues:

1. `conversation_reply` retries cannot succeed once the conversation advanced —
   the gateway's idempotency key is per-task while the request hash covers the
   transcript. **CONTRACT-017A owns it.**
2. $0.60 held by three `outcome_unknown` ledger rows; releasing them needs
   `reconcile-provider-attempt.ts` with a real evidence SHA.
3. M7's security review was **not independent** — same session, same author.
   `/security-review` could not launch (`origin/HEAD` unset, now fixed);
   re-running it is recommended before CONTRACT-018.
4. No migrations ledger. Applied-or-not is a schema inspection.

## Acceptance

| Owner acceptance criterion                                                     | Met                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Learns from Telegram that a run succeeded or failed, without the dashboard     | yes — M1/M2, and a real failure report was received    |
| Approves or rejects a pending decision from their phone                        | yes — M4, proven by a real tap                         |
| Asks the factory a question and gets a real answer in the chat                 | yes — M5, and again at M6 (`b239fe1`, 8 s, tool-using) |
| Asks for status, runs, approvals, budget                                       | yes — M6, all four against real staging data           |
| Anything outside the command set gets a plain refusal naming what is available | yes — M6                                               |
