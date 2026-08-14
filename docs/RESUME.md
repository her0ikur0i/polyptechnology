# Resume checkpoint

Start here, then read `AGENTS.md`, `CLAUDE.md`, and the active contract's
`contract.md` (including Amendments). **Check `git log` and `git status` before
assuming anything below is still current** — this file is a summary, the
repository is the truth.

## Current state

Contracts 001–017, 017A, 017B, 017C and 017D are all closed and pushed.
**`CONTRACT-017D` (the drill, reproducible and unattended) closed on
2026-08-12** with 414 backend tests passing and zero skipped, 38 dashboard
tests, and a security review with no findings run before the push.

**The factory now generates software end to end, and the escalation chain is
proven in both directions on real, paid drills**: a run that exhausts every
earlier tier reaching `claude-sonnet-5`, and a run that accepts on a middle
tier without ever needing the last one. Work routes
`deepseek → codex → claude`, cheapest tier first. Telegram reports now name
every tier a run actually walked, not just the model that cost the most.
Two clean-database drills, run independently, produced identical terminal
results. $15.00 in stranded reservations were reconciled with real,
re-hashable evidence.

After CONTRACT-017D closed, two follow-up items were completed outside of a
contract. Commit `24aa291` — "factory: raise generation task budget cap to
$5.00" — raised the per-generation-task AI-provider budget cap in
`src/factory/generation-task.ts` from $3.00 to $5.00 (headroom for larger
future projects; per-attempt cost remains $0.50). Commit `405fac7` —
"scripts/generation-drill: add a landing-page brief" — added a `landing` brief
to `scripts/generation-drill.ts` alongside `simple` and `deep`, testing product
goal 1 (generates anything from a landing page to a complex system) for the
first time. Live drill on 2026-08-12 against staging reached `publication`:
`deepseek-v4-flash` was rejected, `deepseek-v4-pro` was rejected, and
`codex:gpt-5.6-terra` accepted and verified. The generated landing page was
complete, self-contained HTML (inline CSS only) with title, headline, pitch,
and call-to-action, published to the owner as a Claude Artifact.

Three more follow-up items were completed outside of contract. Commit `103f1e4`
— "fix: report headline names the accepted model, not the costliest reject" —
fixed a real bug in `PostgresRunFacts.usageFor()` in `src/operations/run-notifier.ts`:
the headline for a generation task's report picked the costliest attempt
unconditionally, which is right for a failure but wrong for a success — a
rejected DeepSeek attempt is often costlier than an accepted Codex attempt,
since Codex and Claude are subscription CLIs billing $0 real dollars, so
successful reports routinely named the rejected provider. Now an attempt
with an accepted `provider_artifacts` row
ranks first; cost-ranking applies only to failures (unchanged). Same commit
upgraded `scripts/generation-drill.ts`'s `landing` brief with senior-designer-level
direction (token system, information architecture, type scale, hover/focus states,
responsive layout) and tightened two assertions in
`tests/postgres-gateway.integration.test.ts` that were asserting exact global table
state instead of just their own test's rows. Re-ran the landing-page drill with the
upgraded brief on 2026-08-12 against staging: reached `publication` on
`codex:gpt-5.6-terra` after two legitimate DeepSeek rejections, producing a
richer result (382 changed lines vs. 40 before) — design-token system, sticky nav,
hero, three-feature grid, testimonial block, closing CTA, footer, hover/focus
states, and a responsive breakpoint, all in one embedded `<style>` block.
Commit `d6c134d` — "scripts/generation-drill: add a complex, correlated-modules
brief" — added a `complex` brief: a three-file double-entry accounting system
(`accounts.ts`, `ledger.ts`, `reports.ts`) where files import from and must
agree with each other, unlike every earlier brief which was one module with
several rules. Run on 2026-08-12 against staging reached `publication` after
walking all four available tiers for the first time in a fully legitimate way —
`deepseek-v4-flash` (real failing test), `deepseek-v4-pro` (real TypeScript
syntax error), `codex:gpt-5.6-terra` (real module-resolution failure),
`codex:gpt-5.6-sol` (accepted). Twelve tests passed independently of the drill's
own verification. No infra defect involved; every rejection was the verification
gate correctly catching something real.

One follow-up item was completed outside of contract on 2026-08-14. Commit
`2580d0d` — "fix: /dashboard/snapshot 500 and finish M7 runs-page aggregates" —
fixed `/api/v1/dashboard/snapshot` returning 500. Commit `d1ad072` (deepseek) had
added `array_agg(t.id)` (a `uuid[]`) inside a `COALESCE(..., '{}'::text[])`;
PostgreSQL rejects the mixed array types, so the snapshot endpoint — and every
control-api test that reads it — failed. Casting to `t.id::text` and dropping a
duplicate `c.id` from `GROUP BY` fixed it; the same commit also finished the M7
runs-page aggregate metrics. Zero-skip suite is green again: 445 backend tests,
55 dashboard tests, 0 skipped.

Further owner-directed work on 2026-08-14, outside a contract. The Telegram
loading indicator is now a real animated sticker: the owner's Lottie
(`loading.json`, the colourful burst) was scaled 1080→512 and uploaded as a
`.tgs` sticker (`polyp_loading_by_PolypTech_bot`), and `TelegramSpinner` now
sends that sticker — deleting it the moment the reply lands — instead of text
frames or a GIF. The generation report was then reworked: the final phase of a
multi-phase run is the whole run's verdict, so it now sends a milestone-style
summary (conversation → proposal → blueprint → generation → verification →
publication, plus commit, model, and cost) rather than a per-phase line;
intermediate phases and blueprint translation stay silent, and failures stay
visible. Generation tasks record their `phaseLabel` in the spec input so the
notifier can tell the last phase apart, and the commit SHA is read from the
generated repo's real `HEAD`. Staging was then scrubbed back to a single owner
conversation (the drill projects, test conversations, their workspaces, and old
releases removed).

## Closed: CONTRACT-017B — truthful reporting and a real backoff

**CLOSED at `7021e59`.** Inserted 2026-08-11 after the owner read a full day of
their own Telegram transcript and found four defects that no test and no query
had surfaced, because each is only visible as a message a person reads on a
phone. Charter and evidence in `docs/contracts/CONTRACT-017B/`.

**Its M0 also answered CONTRACT-017A's and CONTRACT-018's open questions**, so
the three run without pausing — see
`docs/contracts/CONTRACT-017B/evidence/M0-owner-confirmation.md` before
assuming any of those decisions were invented.

## Closed: CONTRACT-017A — session-based conversation continuity

**CLOSED at `d016de0`.** Charter and evidence in
`docs/contracts/CONTRACT-017A/`. Whole-transcript replay is gone: a turn
resumes the provider's own session and sends only the new message — **2 input
tokens per resumed turn against ~2,500 for a cold start**, measured from the
ledger. `SYSTEM_PROMPT_FINGERPRINT` is retired, so editing the prompt no longer
throws away the owner's thread, and a `conversation_reply` retry now reaches a
provider instead of dying on `idempotency intent mismatch`.

Its M0 was answered in advance, in CONTRACT-017B's M0 batch — recorded in this
contract's own `evidence/M0-owner-confirmation.md` so it is discoverable from
the contract it governs.

**The lesson from its live drill, which no test could have given:** every unit
test passed while the feature did not work at all. The first genuinely resumed
turn was rejected by the ledger, the driver read the rejection as an expired
session, dropped it, and cold-started — so the owner saw a correct answer, the
system reported success, and continuity never happened. It was found in one
line of the supervisor log, which exists because CONTRACT-017B added it.

## Closed: CONTRACT-017C — the factory generates software

**CLOSED.** Charter and evidence in `docs/contracts/CONTRACT-017C/`.

When this contract opened, the generation pipeline had **never run**: 7
projects on staging, all in `idea`, 0 proposals, 0 generation tasks. It now
runs end to end. Two consecutive deep drills each took a brief through
conversation → proposal → approval → blueprint → workspace → generation →
verification → publication with nothing human after the brief, and produced two
different correct implementations. Both accepted on `deepseek-v4-flash`; an
earlier run escalated to `codex:gpt-5.6-terra` before accepting.

**Nine defects, every one at a boundary between components.** The three that
must not be re-learned:

- **`PrivateTmp=yes` meant the verification sandbox had never seen a file.**
  The verify workspace was created under `tmpdir()`; Docker bind-mounts by host
  path, so the daemon mounted an empty directory and every verification in this
  system's history ran against nothing. Its integration tests passed throughout.
  **Anything crossing from a service process into a container must not live in
  `/tmp`.**
- **The escalation chain could not leave tier one.** With no owner policy
  active — the normal state — the route resolver returned the same fallback
  forever, so `deepseek → codex → claude` existed only on paper.
- **The budget counted imaginary money.** Subscription providers' notional
  costs were banked as spend (97% of the total) and exhausted real scopes.
  `src/gateway/provider-billing.ts` records who actually bills.

## Closed: CONTRACT-017D — the drill, reproducible and unattended

**CLOSED.** Charter and evidence in `docs/contracts/CONTRACT-017D/`. Opened
because CONTRACT-017C's every success came from one brief — `slugify`, a
single pure function — which proved the pipeline runs but not that it
generalises. A harder brief (`moneybag`: several functions, real error
cases, exact-accounting) failed on every tier, twice, in M0.

**M1 overturned M0's own framing.** The failure was never about model
capability or attempt budget: **the supervisor was killing itself whenever
Codex ran.** `TasksMax=64` was one task short of a single `codex exec`
(measured: 57 tasks peak, against a supervisor idling at 11); the cgroup ran
out of task slots mid-attempt, the next `fork(2)` returned `EAGAIN`, and the
fork that failed was the watchdog ping — whose `spawn()` had no `'error'`
listener, so an unhandled error killed the process outright, stranding the
in-flight attempt forever. All twenty stranded rows were Codex; none was
DeepSeek. Fixed: the watchdog ping can no longer kill the supervisor,
`TasksMax` is 512, shutdown drains the in-flight attempt before `pool.end()`,
and `AttemptLedger.reclaimStranded()` — the ledger's counterpart to the work
engine's `reclaimExpired()` — settles anything still `dispatched` past 30
minutes as `outcome_unknown`.

**M2 found a second ceiling right next to the first, then a third defect
while proving the fix.** The per-task budget scope was capped at $2.00 while
each attempt reserves up to $0.50 and `maxAttempts: 6` — only 4 attempts
were ever fundable, so `claude-sonnet-5` was structurally unreachable no
matter how many attempts remained. Raised to $3.00. The first drill under
the new cap then walked all five tiers for the first time ever — on
evidence that wasn't real: `NODE_ENV=production` (the real supervisor's own
environment) makes `npm install` silently skip every devDependency,
so every generated scaffold had no `tsc` and four "rejections" were a
shell "not found," not a verdict. Fixed with `npm_config_include: "dev"`
and a regression test that sets the ambient variable explicitly. The
second, honest drill run then produced the first-ever accepted, verified,
published result for `moneybag` — on `codex:gpt-5.6-sol`, without ever
needing `claude-sonnet-5`.

**M3** made reports name every tier a run walked, in order, not just
whichever attempt cost the most. **M4** ran the drill twice from
genuinely clean, independent databases (fresh containers, fresh
workspaces, throwaway supervisors) and got identical terminal results.
**M5** reconciled $15.00 in stranded reservations with real,
re-hashable evidence, leaving only the one attempt that actually reached
a provider and needs an external check.

Run the deep brief with:

```
DATABASE_URL=… PROJECT_WORKSPACES_ROOT=… \
  node --import tsx scripts/generation-drill.ts <label> deep
```

**"cleanup protocol"** — when the owner says these words, reset the factory's
work products. Run `scripts/cleanup-protocol.ts` (needs `DATABASE_URL` and
`PROJECT_WORKSPACES_ROOT`): it deletes every generated project, conversation,
task, attempt, contract, milestone, budget scope and blueprint, then removes
the on-disk workspaces and prunes old release images. Factory config
(providers, policies, Telegram settings) and the audit/domain-event trail are
left alone. It is deliberately destructive — invoking it is the confirmation.

## Next: CONTRACT-018 — chat experience

Charter at
`docs/contracts/CONTRACT-018/contract.md`; its M0 evidence records five owner
decisions that carry forward and are **not re-asked**: the left rail starts
collapsed on every screen, per-message cost stays visible, the palette is
unchanged, the composer is centred sharing one measure with the thread, and
Factory Live follows `references/neural-reference-3d.html` from the owner's
`her0ikur0i/polyptech` repository plus Gource-style growth (recorded as an
amendment to CONTRACT-019).

## Closed: CONTRACT-017 — Telegram as a working control surface

**CLOSED at `2e4290b`.** Charter at
`docs/contracts/CONTRACT-017/contract.md`, including **Amendment 1** (the
assistant runs with tools) and **Amendment 2** (this resume protocol, and what
the standing authority covers). Per-milestone state lives in
`docs/contracts/CONTRACT-017/evidence/`; the presence of `M<n>-*.md` is the
authoritative signal that milestone `n` is done.

The block below is **generated** — regenerate it as the last step of every
milestone, never hand-edit it. It follows the contract named in the
`resume:contract` marker beside it, because inference from directory names
broke the moment CONTRACT-017A was opened after CONTRACT-017B had closed. Move
the marker when a new contract starts:

```
node --import tsx scripts/resume-checkpoint.ts          # rewrite it
node --import tsx scripts/resume-checkpoint.ts --check  # fail if stale
```

<!-- resume:contract: CONTRACT-019 -->
<!-- resume:auto:start -->

<!-- Generated by scripts/resume-checkpoint.ts. Do not hand-edit: run it. -->

**Active contract: CONTRACT-019** — 7 of 13 milestones evidenced, generated 2026-08-14.

| Milestone | Subject                                                                 | State                                  |
| --------- | ----------------------------------------------------------------------- | -------------------------------------- |
| M0        | owner approval and operating model                                      | done — `M0-owner-approval.md`          |
| M1        | design-source consolidation and dashboard navigation map                | done — `M1-design-map.md`              |
| M2        | authenticated `dash.surachmancenter.com` access plan and rollback probe | done — `M2-access-plan.md`             |
| M3        | shell/navigation polish                                                 | done — `M3-shell-navigation.md`        |
| M4        | Telegram settings and test panel                                        | done — `M4-telegram-panel.md`          |
| M5        | conversation goal-clarification mode                                    | done — `M5-goal-clarification-mode.md` |
| M6        | project generation flow surface                                         | done — `M6-project-generation-flow.md` |
| M7        | runs, attempts, evidence, and model-cost surface                        | **next**                               |
| M8        | model policy and selection UI                                           | not started                            |
| M9        | Factory Live first real visualization pass                              | not started                            |
| M10       | responsive, accessibility, loading, and error-state polish              | not started                            |
| M11       | live end-to-end dashboard drill                                         | not started                            |
| M12       | security review, README, resume checkpoint, deploy, and close           | not started                            |

- **HEAD:** `9b34579 feat: cleanup protocol — one command resets the factory's work products`
- **Working tree:** clean
- **Next action:** M7 — runs, attempts, evidence, and model-cost surface

<!-- resume:auto:end -->

**Telegram is two-way and live.** The poller runs in the supervisor, approvals
are answerable by tapping, and the buttons clear on decision. Two lessons from
this contract, both found only by running it: an earlier handler checked for
invented outcome strings (`"approved"`) instead of the real ones (`"decided"`,
`"replayed"` — see `src/approvals/postgres-repository.ts`), and its failures
were swallowed silently so nothing reported the breakage. Failure paths in
`src/telegram/approval-handler.ts` now log.

**Execution is now live.** `polyp-sequence.service` runs, provider credentials
are in `/etc/polyp-ai-factory/` (`0640 root:polyp-factory`), and real Claude
calls happen. See `evidence/execution-enabled.md` for the four deployment
defects that turning it on exposed. Real spend so far: **$0.87 total** across
the six budget scopes in the staging ledger, plus **$0.60 reserved but never
released** (see known issues), against a **$5.00 cap per scope**. Report spend after each drill
rather than tallying it silently; read it with
`select scope_id, spent_usd_micros/1000000.0, max_cost_usd_micros/1000000.0 from ai_budget_accounts;`
against the staging database rather than adding numbers up by hand.

`polyp-sequence.service` must NOT be run with `--jitless` or
`MemoryDenyWriteExecute=true` — that combination disables WebAssembly, which
Node's bundled undici needs for `fetch`, and it killed the supervisor mid-run.
The unit records why.

Migration `0015` is applied to **both** the test and the staging databases —
staging received it during the M3/M4 live drills, not at M8 as originally
planned, because the poller could not run without it. Verified at M8:
`telegram_settings.update_offset` exists on `polyp-staging-pg`. There is no
migrations ledger table in either database; "applied" is established by
inspecting the schema.

Under the standing zero-skip invocation the suite reports **371 tests, 371
passing, 0 skipped** (2026-08-11). Up from 353 at CONTRACT-017B's close: +7
`provider-sessions`, +9 `conversation-resume`, +1 `resume-checkpoint`, +1
`telegram-conversation-handler`. A different number means something changed —
account for the difference rather than letting it pass, and state the
invocation alongside any count you report.

**`provider_request_id` is a session id, not a call id.** One value covers
every turn of a resumed conversation. Per-call identity is
`ai_gateway_attempts.id`. Two unique constraints assumed otherwise and were
dropped in migration `0017`; anything new that keys off `provider_request_id`
must not assume uniqueness.

**`runOne()` is global.** It leases the first eligible task in the whole
database, and since the retry sweep landed there is reliably more eligible work
than your own fixture. A test that needs its own task must use
`tests/run-own-task.ts`; a test that asserts the queue is empty is asserting
that no other suite is working, and will flake.

Owner-prioritised on 2026-08-10: every run report (success **and** failure) to
Telegram, every confirmation approvable there, plus conversation and commands.
CONTRACT-016 was descoped by its Amendment 1 to make room rather than absorb it.

Three decisions already settled, so they are not relitigated:

- **Long polling, never `setWebhook`.** Telegram's webhook transport needs a
  public HTTPS endpoint this deployment does not have; `getUpdates` is outbound,
  so inbound Telegram needs no public exposure and no DNS change. Verified
  against the live bot: no webhook is set and `getUpdates` succeeds. The two
  transports are mutually exclusive.
- **Commands are a closed set** — status, active runs, pending approvals,
  budget, and answering decisions that already exist. The owner confirmed this
  is sufficient. A command outside the set is refused, never interpreted.
  **Conversation is a different path and is no longer bounded that way**: by
  Amendment 1 the assistant runs with tools as root inside this repository, so
  a chat message _can_ change this repo. It still cannot reach the factory's
  generation pipeline except through a proposal the owner approves
  (`scripts/propose.ts`).
- **HTML parse mode, not MarkdownV2 and no longer plain text.** The live probe's
  first attempt failed on MarkdownV2 escaping, because report text quotes paths
  and identifiers constantly — HTML needs 3 characters escaped against
  MarkdownV2's ~18. A failure report that fails to send is the worst bug a
  notifier can have.

Telegram credentials are in `/root/.config/polyp/provider-secrets.env`
(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`); the bot is `@PolypTech_bot`. Staging
itself still has no Telegram configuration, so the inbound webhook route stays
unregistered there — deliberate, since this contract uses polling instead.

After 017A: **018 chat experience** on the streaming foundation, then 019
Factory Live producer, 020 design system, 021 multi-stack, 022 domains and
detach.

Two things from CONTRACT-015 worth carrying forward rather than rediscovering:
its M8 independent review found a critical bug that M3's own six passing tests
had missed entirely, because every one of them exercised the same canonical
input shape; and a milestone reported a 1-skipped run as matching a 0-skipped
baseline, which is why the zero-skip invocation is now stated in `CLAUDE.md`.

The roadmap through CONTRACT-022 is `docs/product/roadmap-2026H2.md`. It exists
because the owner set the principle that large scope is split into smaller
contracts so the result can be good, and it records which contract owns which
gap against the five product goals.

### Contract index

Per-milestone detail lives in each contract's `evidence/*.md`. That is the
durable record; this file deliberately no longer restates it.

| Contract | Commit    | Subject                                                       |
| -------- | --------- | ------------------------------------------------------------- |
| 011      | `a564bf8` | Fail-closed routing, real patch executor, policy persistence  |
| 012      | `4342ca2` | Control API server, owner policy UI foundation                |
| 013      | `57facca` | Generation pipeline, policy UI, private staging deployment    |
| 014      | `f58a649` | Conversation workspace: chat replaces the blueprint form      |
| 015      | `4b55447` | Foundation hardening: audit findings, path safety, throttle   |
| 016      | `324b39f` | Streaming foundation: adapter streaming, durable reply chunks |
| 017      | `2e4290b` | Telegram control surface: reports, approvals, chat, commands  |
| 017B     | `7021e59` | Truthful reporting, exponential retry backoff, human labels   |
| 017A     | `d016de0` | Session-based conversation continuity, per-attempt ledger     |

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
  owner checkpoint — and every question the whole contract will need is asked
  there, batched, before any work starts. Nothing after M0 pauses for owner
  input; work that needs an authority M0 did not grant defers to the next
  contract instead of interrupting the current one.
- **Reconfirmed 2026-08-11** for the remainder of CONTRACT-017: migration `0015`
  against the real staging database, `polyp-sequence.service` restarts, live
  Telegram drills that spend real provider money, and the single commit and
  push all proceed without pausing.
- **The resume checkpoint is updated at every milestone**, not at the end of the
  contract, and the milestone table is generated rather than remembered:
  `node --import tsx scripts/resume-checkpoint.ts`. Two consecutive sessions
  ended with the connection dropping mid-milestone while this file claimed a
  finished milestone had not started.
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
TEST_SCAFFOLD_GATES=enabled \
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

- **Public cutover done 2026-08-14.** `dash.surachmancenter.com` now routes
  through the Cloudflare tunnel to the integrated control API/dashboard on
  `127.0.0.1:4180`, gated by app-level owner login (`ACCESS_AUTH_MODE=password`,
  see `docs/operations/owner-authentication.md`). The legacy
  `polyptech-dashboard.service` (`127.0.0.1:4173`, a deleted pre-CONTRACT-007
  codebase) was disabled and stopped. Staging still runs `NODE_ENV=development`
  with no Telegram configuration on this instance (the webhook route stays
  unregistered); the background task-execution supervisor is still not running
  under the control API. **The Telegram live probe is done**
  (owner-authorised 2026-08-10, see
  `docs/contracts/CONTRACT-016/evidence/telegram-live-probe.md`): the stored
  token is valid, the bot is `@PolypTech_bot`, and a report was delivered to the
  owner through the repository's own `TelegramHttpTransport`. Credentials live
  in `/root/.config/polyp/provider-secrets.env`.
- **Cloudflare Access JWT verification is not implemented.** Owner login is
  app-level (`ACCESS_AUTH_MODE=password`), not Cloudflare Access, and the app
  does not verify a Cloudflare Access JWT. CONTRACT-013 M8 left a loopback-bind
  enforcement in `src/config.ts` as an interim network-level guarantee.
  CONTRACT-020 owns the Cloudflare-Access path, since that is the contract that
  contemplates public traffic.
- **Factory Live has no server.** Its client calls
  `/api/v1/factory-live/snapshot` and `/api/v1/factory-live/events`; neither
  route exists. Every test feeds it a fixture, so the suite is green while the
  feature cannot function. Release criterion 8 in
  `docs/contracts/CONTRACT-010/acceptance-matrix.md` is recorded as `Verified`
  on that fixture-fed evidence. **CONTRACT-019** builds the real producer and
  earns the `Verified` back — it was CONTRACT-017's job until Telegram was
  prioritised ahead of it on 2026-08-10 and the roadmap renumbered.
- **Postgres containers running:** `polyp-contract006-pg` (55432, an older
  contract, do not use); `polyp-contract011-pg` (55433, **disposable** test
  database — recreate it fresh rather than deleting rows, since audit tables are
  immutable by trigger); `polyp-staging-pg` (55434, loopback-bound,
  **persistent** volume `polyp-staging-pg-data`, real staging data — not
  disposable).
- **CONTRACT-008 left one ledger attempt** (`66717047-593d-4976-b133-0a04d475e341`)
  in `outcome_unknown`, unreconciled. Relevant only to whichever database becomes
  production, which no contract has designated yet.
- **Three more `outcome_unknown` attempts on staging hold $0.60 reserved**
  (`conversation-reply-{47a0ed46,d0e26d29,15e230ce}-…`), permanently reducing
  what that scope can spend. Releasing them is
  `scripts/reconcile-provider-attempt.ts`, which demands an evidence SHA by
  design; do not invent one to unblock the money.
- ~~**A `conversation_reply` retry cannot succeed once its conversation has
  advanced.**~~ **Fixed by CONTRACT-017A.** Each attempt now carries its own
  ledger identity, so a retry reserves budget and reaches a provider instead of
  throwing `idempotency intent mismatch`. Kept here only so the original
  analysis stays findable: `docs/contracts/CONTRACT-017/evidence/retry-sweep.md`.

## Resume instruction

Launch Claude Code in `/root/polyptechnology-next` and say "resume per
docs/RESUME.md". Read this file, `AGENTS.md`, `CLAUDE.md`, and the active
contract first, then check `git log`/`git status` and the relevant
`evidence/*.md` — they exist so a fresh session never has to reconstruct state
from memory or from `/tmp`.

**If a session ended abruptly**, the generated block above already answers the
three questions worth asking, without reading a transcript: which milestone is
next, what HEAD was, and which file was edited last. Start there, then:

```
node --import tsx scripts/resume-checkpoint.ts --check   # is this file honest?
npm run typecheck                                        # is the tree coherent?
```

An interrupted milestone leaves working code and no `evidence/M<n>-*.md`. That
is the normal, recoverable shape — finish the milestone, write the evidence,
regenerate this block. Nothing is committed until the contract closes, so a
dropped connection never loses more than the un-evidenced milestone in flight.
