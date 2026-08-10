# Resume checkpoint

Start here, then read `AGENTS.md`, `CLAUDE.md`, and the active contract's
`contract.md` (including Amendments). **Check `git log` and `git status` before
assuming anything below is still current** — this file is a summary, the
repository is the truth.

## Current state

Contracts 001–015 are all closed and pushed. `CONTRACT-015` (foundation
hardening) closed at `4b55447` with 193 backend tests passing and zero skipped,
38 dashboard tests, and a private-staging redeploy verified against the live
process. Its charter, the repository-wide audit that motivated it, the owner
acceptance mapping and all ten milestone evidence files are in
`docs/contracts/CONTRACT-015/`.

## CONTRACT-016 is IN PROGRESS and UNCOMMITTED

**Read this section first if `git status` is dirty.** The repository commits
once per contract, so a contract in flight always has uncommitted work on disk.
Nothing is lost by a session ending — the files persist — but a fresh session
must not mistake that state for an accident and must not `git checkout` it away.

`docs/contracts/CONTRACT-016/contract.md` is the charter (11 milestones after
M0). Per-milestone state lives in `docs/contracts/CONTRACT-016/evidence/`; the
presence of `M<n>-*.md` is the authoritative signal that milestone `n` is done.
Trust those files over this paragraph, which can go stale between edits.

| Milestone | State                                                               |
| --------- | ------------------------------------------------------------------- |
| M0        | done — owner confirmation, streaming architecture decision recorded |
| M1        | done — streaming provider invocation, `ClaudeCliAdapter` over spawn |
| M2        | done — durable reply chunks, migration `0014`                       |
| M3        | done — driver writes coalesced chunks; wired in `sequence-main.ts`  |
| M4–M11    | not started                                                         |

**Resume by doing exactly this:**

1. `git status` — expect a dirty tree; `git log --oneline -1` should be
   `30f84ea` (or later if M11 already committed, in which case this section is
   stale and the contract is closed).
2. Read `docs/contracts/CONTRACT-016/contract.md`, then every
   `evidence/M*.md` present, newest milestone last.
3. Run the standing zero-skip invocation below. It should report **212 tests,
   212 passing, 0 skipped**. A different number means something changed since
   this was written — reconcile before continuing, do not assume.
4. Continue at the first milestone with no evidence file, currently M4.

**Migration state that is easy to get wrong.** `0014_reply_streaming.sql` is
already applied to the **disposable test** database and deliberately **not** to
staging; staging gets it at M11 with the redeploy, the same way CONTRACT-014
M10 applied `0011`–`0013`. The migrations are not idempotent — re-running one
fails loudly rather than silently double-applying, which is the safe direction
but still a wasted step.

`psql` is **not installed on this host**. Go through the containers, and note
the two databases use different roles — getting this wrong produces a
`role "postgres" does not exist` error that looks like a broken database and is
really a wrong command:

```bash
# disposable test DB (has 0014)
docker exec -i polyp-contract011-pg psql -U postgres -d polyp_test \
  -v ON_ERROR_STOP=1 < migrations/0014_reply_streaming.sql

# persistent staging DB (must NOT have 0014 until M11) — different role
docker exec polyp-staging-pg psql -U polyp_staging -d polyp_staging \
  -tAc "SELECT to_regclass('public.conversation_reply_chunks') IS NOT NULL;"
```

Verified 2026-08-10: the test DB returns `t`, staging returns `f`.

**The architectural decision M0 recorded, so it is not relitigated:** token
streaming needs the adapter to stream, the fragments to be durable because the
reply is produced in `polyp-sequence.service` and served by the Control API, and
only then an SSE route. Running replies inline in the API would make streaming
trivial and is refused — CONTRACT-014 M2 made replies a background task on
purpose. Streaming state transitions without token text is also refused, as not
what goal 2 asks for.

After CONTRACT-016 the roadmap continues 017 (Factory Live producer), 018
(design system), 019 (multi-stack), 020 (domains, detach, and the closing
full-factory drill).

Two things from CONTRACT-015 worth carrying forward rather than rediscovering:
its M8 independent review found a critical bug that M3's own six passing tests
had missed entirely, because every one of them exercised the same canonical
input shape; and a milestone reported a 1-skipped run as matching a 0-skipped
baseline, which is why the zero-skip invocation is now stated in `CLAUDE.md`.

The roadmap through CONTRACT-020 is `docs/product/roadmap-2026H2.md`. It exists
because the owner set the principle that large scope is split into smaller
contracts so the result can be good, and it records which contract owns which
gap against the five product goals.

### Contract index

Per-milestone detail lives in each contract's `evidence/*.md`. That is the
durable record; this file deliberately no longer restates it.

| Contract | Commit    | Subject                                                      |
| -------- | --------- | ------------------------------------------------------------ |
| 011      | `a564bf8` | Fail-closed routing, real patch executor, policy persistence |
| 012      | `4342ca2` | Control API server, owner policy UI foundation               |
| 013      | `57facca` | Generation pipeline, policy UI, private staging deployment   |
| 014      | `f58a649` | Conversation workspace: chat replaces the blueprint form     |
| 015      | `4b55447` | Foundation hardening: audit findings, path safety, throttle  |

## Owner constraints (current)

- **Advance authority granted 2026-08-09, through the completion of every
  contract in the roadmap**: staging redeploy, the single contract commit, and
  the push all proceed without a further pause once gates are green. Recorded
  in `docs/contracts/CONTRACT-015/evidence/M0-owner-confirmation.md` §2.
  **It does not extend to** public DNS, Cloudflare cutover, public exposure,
  production promotion, `polyptech-dashboard.service`, or anything
  secret-impacting or irreversible — each still needs fresh approval at the
  time.
- **Confirmations go at the front.** Every contract opens with M0, its only
  owner checkpoint. Nothing after M0 pauses for owner input; work that needs an
  authority M0 did not grant defers to the next contract instead of
  interrupting the current one.
- **Small contracts.** Several milestones each, one commit and push per
  contract after all gates pass — never per milestone.
- Claude is strategic orchestrator (Amendment 1 to CONTRACT-011); Codex retains
  integrator/verifier/final-gate duties and is an automatic technical-fallback
  tier; DeepSeek remains the mandatory first executor for programming tasks.
- Execution chain `deepseek → codex → claude`, cheapest viable tier first,
  escalating only on _verified_ same-task failure evidence
  (`src/policy/execution-permission.ts`, `src/policy/failure-classification.ts`).
  A transport/protocol failure retries the same tier, never escalates. The same
  principle governs how orchestration itself picks a model tier per task weight.
- Executor-generated code must pass `npm run format:check` before acceptance —
  cleanliness is enforced mechanically, not left to whichever provider wrote it.
- A provider must never review (`*_review` task classes) a task it executed as a
  technical-fallback tier on.
- Do not request approval for ordinary work — file edits, tests, disposable
  databases, docs.

## Workspace

Canonical system: `/root/polyptechnology-next`. `/opt/master-orchestrator` no
longer exists on disk.

**Standing test invocation (zero skips):**

```
TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test \
TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 \
npm test
```

`TEST_WORKER_IMAGE` is not a workaround —
`tests/ai-patch-driver-docker.integration.test.ts` is deliberately gated so
ordinary runs do not pay a Docker pull cost. The digest is `postgres:17-alpine`;
any real pinned image works. Without these variables large parts of the suite
skip silently, so a test count means nothing unless the invocation is named
alongside it.

Host: 2 vCPU, 7.8 GB RAM, 80 GB free. Run heavy verification serially.

## Known issues — do not silently resolve

- **`polyptech-dashboard.service` is still active** on the host, serving
  `dash.surachmancenter.com` → `127.0.0.1:4173` through the live Cloudflare
  Tunnel, from a process whose files were deleted with
  `/opt/master-orchestrator`. It is a pre-CONTRACT-007 architecture that no
  longer exists in this repository. **Do not stop, restart, or modify it**
  without fresh explicit owner approval.
- **Private staging only.** `/opt/polyp-ai-factory/current`, the `polyp-factory`
  system user, and `polyp-control-api.service` are real (CONTRACT-013 M9,
  redeployed by CONTRACT-014 M10) but loopback-bound on port 4180 with
  `ACCESS_AUTH_MODE=disabled`, no Telegram, and no background task-execution
  supervisor running. This is **not** the public production cutover. The
  remaining CONTRACT-010 Owner Action Bundle items — DNS/Cloudflare cutover,
  external backups, production promotion — all still need fresh approval.
  **The Telegram live probe is done** (owner-authorised 2026-08-10, see
  `docs/contracts/CONTRACT-016/evidence/telegram-live-probe.md`): the stored
  token is valid, the bot is `@PolypTech_bot`, and a report was delivered to the
  owner through the repository's own `TelegramHttpTransport`. Credentials live
  in `/root/.config/polyp/provider-secrets.env`. Staging itself still has **no**
  Telegram configuration, so the webhook route is still unregistered there.
- **Cloudflare Access JWT verification is not implemented.** CONTRACT-013 M8
  left a loopback-bind enforcement in `src/config.ts` as an interim
  network-level guarantee. CONTRACT-020 owns closing it, since that is the
  contract that contemplates public traffic.
- **Factory Live has no server.** Its client calls
  `/api/v1/factory-live/snapshot` and `/api/v1/factory-live/events`; neither
  route exists. Every test feeds it a fixture, so the suite is green while the
  feature cannot function. Release criterion 8 in
  `docs/contracts/CONTRACT-010/acceptance-matrix.md` is recorded as `Verified`
  on that fixture-fed evidence. CONTRACT-017 builds the real producer and earns
  the `Verified` back.
- **Postgres containers running:** `polyp-contract006-pg` (55432, an older
  contract, do not use); `polyp-contract011-pg` (55433, **disposable** test
  database — recreate it fresh rather than deleting rows, since audit tables are
  immutable by trigger); `polyp-staging-pg` (55434, loopback-bound,
  **persistent** volume `polyp-staging-pg-data`, real staging data — not
  disposable).
- **CONTRACT-008 left one ledger attempt** (`66717047-593d-4976-b133-0a04d475e341`)
  in `outcome_unknown`, unreconciled. Relevant only to whichever database becomes
  production, which no contract has designated yet.

## Resume instruction

Launch Claude Code in `/root/polyptechnology-next` and say "resume per
docs/RESUME.md". Read this file, `AGENTS.md`, `CLAUDE.md`, and the active
contract first, then check `git log`/`git status` and the relevant
`evidence/*.md` — they exist so a fresh session never has to reconstruct state
from memory or from `/tmp`.
