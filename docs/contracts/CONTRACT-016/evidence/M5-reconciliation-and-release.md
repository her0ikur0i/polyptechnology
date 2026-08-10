# M5 — Evidence reconciliation, staging redeploy, commit and push

Date: 2026-08-10. Status: **done**.

Executed under the advance authority granted at CONTRACT-015 M0 and reaffirmed
when the owner said to run the sequence until every contract is finished.
Nothing here touched public DNS, production, secrets, or
`polyptech-dashboard.service`.

## Final gates

| Gate                      | Result                          |
| ------------------------- | ------------------------------- |
| Backend suite (zero-skip) | 221 passed, 0 failed, 0 skipped |
| Dashboard suite           | 38 passed across 5 files        |
| `npm run typecheck`       | clean                           |
| `npm run format:check`    | clean repository-wide           |
| `npm audit`               | 0 vulnerabilities               |
| `verify-contract.ts`      | structure and scope OK          |
| Dashboard build           | 4 chunks, 0 sourcemaps          |

Test-count trail: **193 → 199 → 205 → 212 → 221**, every rise real coverage.

## What this contract actually shipped

A streaming path through the provider layer, and nothing that consumes it yet.
`ClaudeCliAdapter` runs the CLI over `spawn` with `--output-format stream-json`;
fragments are coalesced by size and time into durable rows that cross the
process boundary between `polyp-sequence.service` and the Control API.

It ships **inert**, deliberately and stated plainly in Amendment 1: nothing
reads the chunks. Replies work exactly as before, arriving whole. That was a
safe place to stop only because of the principle everything here is built on —
`ManagedCompletion.content` is the answer, fragments are disposable progress —
which the M4 independent review verified by tracing every hop rather than
trusting the comments.

## Staging redeploy

Migration `0014_reply_streaming.sql` applied to `polyp-staging-pg`, verified
after: the table exists and carries exactly three indexes — primary key, the
unique constraint's, and the age index — with the duplicate M4 caught **not**
present, confirming the amended migration is what ran.

New release `20260810T032715Z-contract016`, built from this tree, with
`/opt/polyp-ai-factory/current` repointed. The previous release
(`20260810T011359Z-contract015`) stays in place, so rollback remains a symlink
swap and a restart.

Live against the running process after restart: `healthz` 200, SPA 200. Same
trust boundary as before — loopback `127.0.0.1:4180`, `ACCESS_AUTH_MODE=disabled`,
no Telegram configuration on the instance, `polyp-sequence.service` still not
running.

## Honest note on what "verified live" covers here

The streaming transport itself was **not** exercised against the real Claude CLI
on staging, and this evidence does not claim it was. Doing so means a real,
costed provider call, which CONTRACT-013 M9 decision 4 withheld and no grant has
extended. What was verified live is that the release boots, serves, and carries
the new schema.

The transport is covered instead by `tests/stream-runner.test.ts`, which drives
the **real** `defaultStreamRunner` against real spawned child processes —
timeout kills, stderr tail retention under 70 kB of noise, an unterminated
giant line, split-line reassembly, and a missing binary. That is genuine
process-level evidence, not a mock, and it is the strongest verification
available without spending money.

## Follow-ups this contract deliberately hands on

- **CONTRACT-017** (next, owner-prioritised): Telegram reports, approvals,
  conversation and commands.
- **CONTRACT-018**: the SSE route and the client that finally reads these
  chunks — plus the age-based retention sweep, whose absence M4 forced into the
  open after two files had claimed it existed.

## Commit

One commit containing every milestone's work and evidence, pushed to `main` on
`origin`.
