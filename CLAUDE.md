# Polyp AI Factory — orientation

A single-owner AI software factory. The Master Dashboard is its **control
plane**: it turns conversations into approved contracts, delegates bounded work
to AI agents, verifies the results, and operates generated projects that stay
isolated from it.

Generated projects are products of the factory, never modules of it. Nothing
about a specific generated project may be hard-coded into the control plane.

## Read these first, in this order

1. `AGENTS.md` — the operating policy. It outranks anything you infer from code.
2. `docs/RESUME.md` — current delivery state and live known issues.
3. `docs/product/roadmap-2026H2.md` — where the work is going and why.
4. The active contract's `docs/contracts/CONTRACT-NNN/contract.md`, including
   any Amendments, plus its `evidence/*.md`.

Check `git log` and `git status` before assuming any of it is still current.

## Running and verifying

```bash
npm ci
npm run verify     # typecheck + backend tests + dashboard tests + dashboard build
```

**Use the zero-skip invocation for anything you intend to trust:**

```bash
TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test \
TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 \
TEST_SCAFFOLD_GATES=enabled \
npm test
```

This matters more than it looks. Large parts of the suite are gated behind
`{ skip: databaseUrl === undefined }` and `{ skip: !dockerAvailable }`, so a
bare `npm test` on a machine without those variables passes while testing very
little. A test count is meaningless unless you also name the invocation that
produced it. `TEST_WORKER_IMAGE` is not a workaround — the Docker suite is
deliberately opt-in so ordinary runs do not pay a pull cost.

Other useful commands: `npm run dashboard:dev`, `npm run dashboard:test`,
`npm run format:check`, `node --import tsx scripts/verify-contract.ts CONTRACT-NNN`.

## Shape of the system

Modular monolith, TypeScript ESM, strict. Express 5 + PostgreSQL (raw `pg`, no
ORM), React 19 + Vite for the dashboard, Docker for isolated workers.

| Area              | Where                 | What it owns                                                        |
| ----------------- | --------------------- | ------------------------------------------------------------------- |
| HTTP surface      | `src/control-api/**`  | Every route, auth, CSRF, rate limiting, SPA serving                 |
| Conversations     | `src/orchestrator/**` | Conversations, messages, attachments, proposals, supervision        |
| Contracts & tasks | `src/work/**`         | Durable work engine, leases and fencing, publication                |
| AI routing        | `src/gateway/**`      | **The live provider path.** Adapters, model policy, budget ledger   |
| Routing policy    | `src/policy/**`       | Runtime policy, execution permission, failure classification        |
| Generation        | `src/factory/**`      | Blueprints, workspace provisioning, generation tasks                |
| Execution & ops   | `src/operations/**`   | Patch drivers, supervision, telemetry, incidents, backup, retention |
| Isolated workers  | `src/worker/**`       | Docker planning and execution                                       |
| Dashboard         | `src/dashboard/**`    | The owner's workspace UI                                            |
| Schema            | `migrations/*.sql`    | Forward-only, applied in filename order                             |

Architecture decisions live in `docs/architecture/adr-*.md`. Read the relevant
ADR before changing a boundary it governs.

## Invariants that must not be weakened

- **Model output is untrusted.** Chat text, attachments, and AI-authored patches
  are suggestions, never authorization. Everything reaching the **factory's
  generation pipeline** passes the proposal
  `draft → owner_review → approved → handed_off` gate first
  (`docs/architecture/adr-0002-conversation-authority-boundary.md`).
  **One owner-instructed carve-out**, CONTRACT-017 Amendment 1: the assistant
  the owner talks to directly runs with tools in this repository, so a
  conversation _can_ change this repo. It still cannot reach the generation
  pipeline except through a proposal the owner approves.
- **One path guard.** `src/safe-path.ts` is the single implementation for the
  worker, publication, and patch-scope boundaries. Do not add a fourth private
  copy — three existed and drifted, which is why it was unified. It is a
  string-level guard; symlink containment comes from the Docker sandbox, not
  from it.
- **Policy activation is canary-gated.** `PostgresPolicyStore.validate()`
  refuses a draft without a passing canary record bound to that policy's
  `policy_sha256`. Run `scripts/policy-canary.ts` with `POLICY_ID` and
  `POLICY_VERSION` set to produce that record.
- **Fail closed.** Absent configuration means a route is not registered at all,
  not that it accepts anonymous callers. Budget, verification, and approval
  checks refuse on doubt.
- **No secrets in argv.** Provider credentials travel in headers or resolved
  files, never on a command line — `/proc/<pid>/cmdline` is world-readable.
- **Cheapest viable model tier first.** `deepseek → codex → claude`, escalating
  only on verified same-task failure evidence. A transport failure retries the
  same tier — **once**, then the chain moves on.

  The "once" was added on 2026-08-11 and the invariant is weaker for it, so the
  reason is recorded rather than assumed. As originally written, a tier that
  failed without recording a verdict was retried indefinitely: it left no
  `provider_artifacts` row, so it never looked "tried". On the first hard brief
  the Codex CLI returned unparseable telemetry three times running, consumed
  every remaining attempt, and **`claude-sonnet-5` — the last tier, and the one
  most likely to succeed — was never asked at all.** A rule meant to stop
  premature escalation had become a rule that guaranteed the chain never
  finished. One retry keeps the original intent (a timeout says nothing about
  whether that model could do the work) without the dead end.

## Delivery discipline

Work happens in small contracts, each with several milestones. **Exactly one
commit and push per contract**, after every gate is green — not per milestone.
Milestone evidence lives in `docs/contracts/CONTRACT-NNN/evidence/*.md`.

**Closing a milestone has two steps, not one:** write its
`evidence/M<n>-*.md`, then regenerate the resume checkpoint with
`node --import tsx scripts/resume-checkpoint.ts`. Since one commit covers a
whole contract, an interrupted session's only durable record of where it got to
is that pair. `--check` fails when `docs/RESUME.md` has drifted from the
evidence on disk.

Since CONTRACT-015, each contract opens with **M0, its only owner checkpoint**:
scope approval, record corrections, and advance approval for the staging
redeploy and the commit/push. Nothing after M0 pauses for owner input.

`scripts/verify-contract.ts` enforces that a contract's changes stay inside its
declared File ownership list. If it flags a path, resolve it by review, not by
assuming the tool is right — it has no notion of milestones or documented
exceptions.

## Do not touch without fresh owner approval

- **`polyptech-dashboard.service`** — still active on the host, serving
  `dash.surachmancenter.com`, from a deleted pre-CONTRACT-007 codebase that no
  longer exists in this repository. Leave it alone.
- Public DNS, Cloudflare cutover, public hostname exposure, production
  promotion, or anything secret-impacting or irreversible.
- `polyp-staging-pg` (port 55434) holds **real** staging data on a persistent
  volume. `polyp-contract011-pg` (55433) is the disposable test database —
  recreate it rather than deleting rows, since audit tables are immutable by
  trigger.

## Traps that have already cost time

- **Integration tests are not enough to prove a server boots.** Express 5's
  router rejects a bare `"*"` route at startup; no integration test caught it
  because none exercised the SPA path. Run the real server as a live process at
  least once per milestone.
- **A green suite can hide a missing half.** Factory Live's client is fully
  tested against a fixture while its server routes do not exist at all. Ask what
  a test is actually wired to before trusting it.
- **Prettier is a mechanical gate**, repository-wide, and CI fails on it.
- Contract test counts change when dead code and its tests are removed together.
  State the new number and account for the difference rather than letting a
  smaller count read as a regression.
