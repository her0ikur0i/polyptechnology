# Technical architecture — Polyp AI Factory

How the system is actually built, as of 2026-08-11. Where this document and the
code disagree, **the code is right and this document is a bug.**

Companions: `docs/SYSTEM-SPECIFICATION.md` (intent, numbered sections),
`docs/product/PRD.md` (what it must do and how proven each part is), the ADRs
in `docs/architecture/adr-*.md` (individual decisions and their reasoning).

## 1. Shape

A modular monolith in TypeScript ESM on Node 22, plus isolated worker
containers. One repository, one deployment, one database.

```text
                    owner
                      |
        +-------------+--------------+
        |                            |
   Dashboard (React 19 + Vite)   Telegram (long polling, outbound only)
        |                            |
        +-------------+--------------+
                      |
             Control API (Express 5)          polyp-control-api.service
                      |                        User=polyp-factory, loopback:4180
                      v
                 PostgreSQL  <--------------- the single source of truth
                      ^
                      |
          Sequence supervisor                 polyp-sequence.service
          (leases, drivers, retries)          User=root
                      |
          +-----------+-----------+
          |                       |
   provider adapters      isolated worker containers
   (CLI subprocesses)     (docker run --read-only --network=none)
```

**There is no Redis and no BullMQ.** Earlier revisions of the specification and
of `docs/architecture/system.md` named them; they were never introduced. The
durable job engine is `src/work/**` on PostgreSQL — leases with fencing tokens,
heartbeats, attempt ordinals and state transitions in SQL. Corrected here
2026-08-11 rather than left to mislead the next reader.

## 2. Modules

| Area              | Path                  | Owns                                                               |
| ----------------- | --------------------- | ------------------------------------------------------------------ |
| HTTP surface      | `src/control-api/**`  | Every route, auth, CSRF, rate limiting, SPA serving                |
| Conversations     | `src/orchestrator/**` | Conversations, messages, attachments, proposals, provider sessions |
| Work engine       | `src/work/**`         | Tasks, leases, fencing, state machine, publication                 |
| AI routing        | `src/gateway/**`      | Adapters, model policy, attempt ledger, budget reservation         |
| Routing policy    | `src/policy/**`       | Runtime policy, execution permission, failure classification       |
| Generation        | `src/factory/**`      | Blueprints, lifecycle, workspace provisioning, generation tasks    |
| Execution and ops | `src/operations/**`   | Drivers, supervision, telemetry, incidents, backup, retention      |
| Isolated workers  | `src/worker/**`       | Docker planning and execution                                      |
| Telegram          | `src/telegram/**`     | Poller, handlers, transport                                        |
| Dashboard         | `src/dashboard/**`    | The owner's workspace UI                                           |
| Schema            | `migrations/*.sql`    | Forward-only, applied in filename order                            |

Modules talk through typed services and durable rows. No ORM: raw `pg` with
explicit SQL, so what runs is what is written.

## 3. The work engine

Everything asynchronous is a task. There is one loop and one set of rules.

- `tasks` carries state, attempt ordinal, cost ceiling and max attempts.
- `operation_task_specs` carries the driver name and a jsonb input.
  **This row is immutable by trigger** — a fact that has caused two separate
  defects, because anything derived per-attempt cannot live in it.
- `ExecutableTaskSupervisor.runOne()` leases the first eligible task **in the
  whole database**, transitions `leased → running → verifying → succeeded`, and
  writes numbered evidence rows at each step.

Two properties worth knowing before writing anything that touches it:

1. **`runOne()` is global.** A test that needs its own task must use
   `tests/run-own-task.ts`; a test asserting the queue is empty is asserting
   that no other suite is working.
2. **Verification is self-declared when `expected_output_sha256` is NULL.** The
   supervisor then requires the driver's output to be `{verified: true}`. Every
   AI-backed driver takes this path, because no hash can be known in advance.

### Registered drivers

| Driver                  | Class                        | Purpose                      |
| ----------------------- | ---------------------------- | ---------------------------- |
| `deterministic_sha256`  | `DeterministicSha256Driver`  | Reference/self-test          |
| `ai_patch_executor`     | `AiPatchOperationDriver`     | Code generation and patching |
| `conversation_reply`    | `ConversationReplyDriver`    | Assistant replies            |
| `blueprint_translation` | `BlueprintTranslationDriver` | Proposal → blueprint         |

## 4. The AI gateway and its ledger

`AiGateway.execute()` is the only path to a provider. It:

1. Resolves a route (static `model-policy.ts` table, or the owner's runtime
   policy for the three programming task classes).
2. Hashes the request — `{taskClass, attribution, messages, maxOutputTokens,
maxCostUsdMicros, policyVersion, route}` — **route included.**
3. Reserves in `ai_gateway_attempts` under an advisory lock, keyed by
   `idempotency_key`, and reserves budget against `ai_budget_accounts`.
4. Invokes the adapter, buffered or streaming — both settle identically.
5. Settles usage into `ai_usage_events` and releases the reservation.

**The idempotency contract, stated precisely, because it has bitten twice:**
one key may be used once. Presenting the same key with a _different_ request
hash raises `idempotency intent mismatch`; presenting it with the _same_ hash
returns the existing attempt and the caller sees `attempt already exists`.

Therefore **any driver that can be retried must derive a per-attempt key.**
`ConversationReplyDriver` does this (CONTRACT-017A M3, using
`OperationContext.attemptOrdinal`). `AiPatchOperationDriver` does not, which is
why generation retries have never reached a provider.

**`provider_request_id` is a session id, not a call id.** One value covers every
turn of a resumed conversation. Per-call identity is `ai_gateway_attempts.id`.
Two unique constraints assumed otherwise and were dropped in migration `0017`.

**Not every provider charges money.** `src/gateway/provider-billing.ts` records
which do. DeepSeek is metered through an API key; Claude and Codex are reached
over subscription CLIs where no per-token charge exists — but the Claude CLI
reports what its tokens _would_ have cost, and the gateway banked that as spend
until 2026-08-11. It made 97% of recorded spend imaginary and exhausted real
budget scopes with it. Subscription completions now keep their token counts and
record zero cost. An unknown provider is assumed metered, which errs toward a
stricter budget rather than a blind one.

## 5. The generation pipeline

The product's core path, end to end.

```text
conversation
   → proposal            draft → owner_review → approved → handed_off
   → blueprint           BlueprintTranslationDriver → parseBlueprint()
                         → project_blueprint_versions, project → 'blueprint'
   → workspace           NodeWorkspaceProvisioner: scaffold + git init + npm install
   → generation task     createGenerationTask → driver 'ai_patch_executor'
   → provider call       AiGateway, taskClass 'bulk_code'
   → patch scope check   validatePatchScope against the ownership manifest
   → git apply           into the workspace
   → workspace           NodeWorkspaceProvisioner → project → 'provisioned'
   → normalise           extractUnifiedDiff: unwrap fences, trailing newline
   → patch scope check   validatePatchScope against the ownership manifest
   → git apply --recount into the workspace (revert on rejection)
   → format              the project's own Prettier, run from THIS package
   → verification        copy without .git → docker run → typecheck && format:check && test
   → artifact record     provider_artifacts: accepted | rejected, with output
   → lifecycle           project → 'development'
   → publication         commit into the generated project's own repository
```

**This path was written, unit-tested, audited and security-reviewed without
ever being executed in sequence.** CONTRACT-017C ran it and found nine defects,
every one of them at a boundary between components rather than inside one. The
four that were architecture rather than incidents:

- **There was no terminal state.** `ProjectLifecycle` defined
  `idea → blueprint → provisioned → development → …` and nothing in the codebase
  ever wrote the last two, so a flawless generation left a project at
  `blueprint` forever. `FactoryLifecycleAdvancer` now writes both.
- **Retry was impossible** — §4's key rule, unapplied here, so attempt 1 was the
  only attempt a generation task could make.
- **The escalation chain could not leave tier one.** With no owner policy active
  (the normal state) the route resolver returned the same fallback on every
  attempt, so the `deepseek → codex → claude` chain existed only on paper.
- **The patch target is the real repository.** Still true, and now deliberate:
  a rejected patch is reverted, an accepted one is committed.

One more was deployment rather than code, and was the most consequential of
all: `polyp-sequence.service` sets `PrivateTmp=yes`, and the verification
workspace was created under `tmpdir()`. Docker bind-mounts by **host** path, so
the daemon mounted an empty directory — **no patch this system produced had
ever been verified.** The workspace now lives beside the repository under
`PROJECT_WORKSPACES_ROOT`, a path the service, the API and the Docker daemon
all agree about. Anything that must cross from a service process into a
container must not live in `/tmp`.

**`ProjectLifecycle` still holds its replay records in an in-memory `Map`**, so
idempotent replay of a transition does not survive a restart. Persistence is in
`PostgresProjectFactory`; the in-memory map is a second, weaker layer. Not yet
addressed.

## 6. Isolation

Two boundaries, deliberately different.

**Path safety** — `src/safe-path.ts`, the single implementation for worker,
publication and patch-scope boundaries. Three private copies once existed and
drifted, which is why it was unified. It is a _string-level_ guard.

**Container isolation** — `src/worker/planner.ts` and `executor.ts`.
`docker run` with `--read-only`, `--network=none` by default, pinned image
digests, memory and CPU limits, a byte-capped output, and a refusal to accept
any workspace containing `.git`. Symlink containment comes from here, not from
the string guard.

Consequences that look like bugs until you know them: verification cannot
`npm ci` (no network), so `node_modules` must be copied in; and the copier must
use `verbatimSymlinks` or `node_modules/.bin/*` resolves back to the source.

## 7. Deployment

| Unit                          | User            | Notes                                                        |
| ----------------------------- | --------------- | ------------------------------------------------------------ |
| `polyp-control-api.service`   | `polyp-factory` | Loopback `127.0.0.1:4180`, `ACCESS_AUTH_MODE=disabled`       |
| `polyp-sequence.service`      | `root`          | Supervisor, Telegram poller, drivers                         |
| `polyp-staging-pg`            | container       | Port 55434, loopback, **persistent** volume                  |
| `polyp-contract011-pg`        | container       | Port 55433, **disposable** test database                     |
| `polyptech-dashboard.service` | —               | **Orphaned.** Pre-CONTRACT-007, files deleted. Do not touch. |

Release layout is `/opt/polyp-ai-factory/{releases,current}`; secrets are in
`/etc/polyp-ai-factory/*.env` at `0640 root:polyp-factory`.

**`polyp-sequence.service` must not run with `--jitless` or
`MemoryDenyWriteExecute=true`.** That combination disables WebAssembly, which
Node's bundled undici needs for `fetch`, and it killed the supervisor mid-run.

**A live split worth knowing:** the Control API runs as `polyp-factory` and the
supervisor as `root`. Anything the API creates and the supervisor consumes —
the project workspace, the verification temp directory — crosses a user
boundary. `/var/lib/polyp-ai-factory/project-workspaces` is currently
`root:root 755`, so the API cannot write it at all.

## 8. Trust and authority

Ordered, highest first. From `SYSTEM-SPECIFICATION.md` §4.

```text
owner policy > global security policy > project policy > approved contract
  > milestone > task > conversation context > agent output
```

**Model output is untrusted.** Chat text, attachments and AI-authored patches
are suggestions, never authorization. Everything reaching the generation
pipeline passes `draft → owner_review → approved → handed_off` first.

**One owner-instructed carve-out** (CONTRACT-017 Amendment 1): the assistant the
owner talks to directly runs with tools in this repository, so a conversation
_can_ change this repo. It still cannot reach the generation pipeline except
through a proposal the owner approves.

## 9. Failure philosophy

- **Fail closed.** Absent configuration means a route is not registered, not
  that it accepts anonymous callers. Budget, verification and approval checks
  refuse on doubt.
- **Degrade to the previous behaviour, never to a wrong answer.** A missing
  provider session replays the transcript; a dead chunk stream still lands a
  whole reply.
- **Never swallow a failure silently.** A catch with an empty body hid a broken
  approval handler for a whole contract. Every catch logs.
- **Progress is not record.** Streamed fragments are disposable;
  `ManagedCompletion.content` is the answer.

## 10. Testing

Standing zero-skip invocation — a test count is meaningless without it:

```bash
TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test \
TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 \
npm test
```

Large parts of the suite are gated on `databaseUrl === undefined` and
`!dockerAvailable`, so a bare `npm test` passes while testing very little.

**The limit of unit tests, learned twice and worth stating in the
architecture:** a green suite proves the units agree with their tests, not that
the system works. Factory Live is fully tested against fixtures its server never
produces; the generation pipeline is fully tested and has never run. Any feature
that matters gets a live drill.
