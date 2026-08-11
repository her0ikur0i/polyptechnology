# Polyp AI Factory

Polyp is a single-owner AI software factory. The Master Dashboard is its control
plane: it turns conversations into approved contracts, delegates bounded work to
agents, verifies results, and operates independently isolated generated projects.

The system is rebuilt contract-by-contract. A contract contains multiple
milestones and produces exactly one quality-gated Git commit and push after
every milestone and the final regression gate pass.

## Where to start

| If you want                         | Read                             |
| ----------------------------------- | -------------------------------- |
| Current delivery state              | `docs/RESUME.md`                 |
| The operating policy                | `AGENTS.md`                      |
| Orientation and invariants          | `CLAUDE.md`                      |
| **What it must do, and how proven** | `docs/product/PRD.md`            |
| **How it is built**                 | `docs/architecture/TAD.md`       |
| **What it looks like, and why**     | `docs/design/DESIGN.md`          |
| The master specification            | `docs/SYSTEM-SPECIFICATION.md`   |
| Where the work is going             | `docs/product/roadmap-2026H2.md` |
| A single past decision              | `docs/architecture/adr-*.md`     |
| What a contract actually did        | `docs/contracts/CONTRACT-NNN/`   |

`docs/RESUME.md` carries a generated block — milestone state, HEAD, and the
last file touched — regenerated at every milestone by
`scripts/resume-checkpoint.ts`. It exists so a session that ends mid-milestone
can be resumed without reconstructing anything.

**The PRD marks each requirement Proven, Unproven, Partial or Absent, and the
distinction is load-bearing.** "Unproven" means the code exists, is unit-tested
and reviewed, and has never run end to end — which is the state the entire
generation pipeline turned out to be in. A green suite proves the units agree
with their tests, not that the system works.

## Local verification

```bash
npm ci
npm run verify
```

Use the zero-skip invocation for anything you intend to trust — large parts of
the suite are gated behind environment variables and skip silently without
them, so a test count means nothing unless the invocation is named alongside it:

```bash
TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test \
TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 \
TEST_SCAFFOLD_GATES=enabled \
npm test
```

No production mutation is permitted from a development command. Deterministic
tests never send live Telegram messages.

## Operating it

The owner runs this factory from their phone. Telegram is a full control
surface, not a notifier:

- **Run reports** for anything that finishes — success and final failure.
  Retries are silent, because a retry is not a decision.
- **Approvals** answerable by tapping, with the same single-use,
  identity-bound token semantics as the dashboard.
- **Conversation** with an assistant that has tools inside this repository, at
  the owner's explicit instruction (CONTRACT-017 Amendment 1). It still cannot
  reach the generation pipeline except through a proposal the owner approves.
  Turns **resume a provider session** rather than replaying the thread, so a
  long conversation costs about what a short one costs — 2 input tokens per
  resumed turn against ~2,500 for a cold start.
- **A closed command set** — `/status`, `/runs`, `/approvals`, `/budget`,
  `/help` — all read-only. Anything else is refused, never interpreted.

Inbound uses long polling, so none of this requires a public endpoint, a DNS
change, or a new trust boundary.

Details: `docs/operations/telegram-approvals.md`, and the contract evidence in
`docs/contracts/CONTRACT-017/` and `docs/contracts/CONTRACT-017B/`.

## Conventions worth knowing before changing anything

- **One commit per contract**, after every gate is green — not per milestone.
- **Milestone evidence** lives in `docs/contracts/CONTRACT-NNN/evidence/*.md`.
  The presence of `M<n>-*.md` is the authoritative signal that milestone `n` is
  done; the resume checkpoint reads exactly that.
- **`scripts/verify-contract.ts`** enforces that a contract's changes stay
  inside its declared file-ownership list.
- **A security review runs before the push**, not after.
- **`runOne()` is global**: it leases the first eligible task in the whole
  database. A test that needs its own task must use `tests/run-own-task.ts`.
- **`provider_request_id` is a session id, not a call id.** One value covers
  every turn of a resumed conversation. Per-call identity is
  `ai_gateway_attempts.id`. Two unique constraints assumed otherwise and were
  dropped in migration `0017`.
