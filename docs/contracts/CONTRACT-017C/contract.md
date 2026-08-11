# CONTRACT-017C — Generate a dummy project, for real

## Objective

Make the factory generate a project. Once. All the way through.

Goal 1 of the owner's five is a system that generates anything from a landing
page to a complex system. The code for it exists, is unit-tested, has passed a
repository-wide audit and a security review, and has never run.

## The finding this contract exists for

Queried against the real staging database on 2026-08-11:

| Question                            | Answer                                                |
| ----------------------------------- | ----------------------------------------------------- |
| Generated projects on staging       | 7                                                     |
| …in a state past `idea`             | **0**                                                 |
| Conversation proposals ever created | **0**                                                 |
| Generation tasks ever executed      | **0**                                                 |
| Drivers that have ever run          | `conversation_reply` (24), `deterministic_sha256` (2) |

All seven projects are shells created when a conversation started. Nothing has
ever crossed the boundary from conversation into a generated product.

This is the defect shape CONTRACT-017A found at M5 and named there: **every
test passes while the feature does nothing**, because the tests exercise the
units and nobody ever ran the whole. Finding it before six dashboard screens
are built to operate the pipeline is worth more than any of those screens.

## M0 — Owner confirmation

The owner set the direction on 2026-08-11, after reviewing a mockup of the
dashboard:

> "backend first, make sure everything connected and the pipeline works and
> wild tested it until success generating dummy project, then move to frontend
> and make sure every function and feature works"

That is this contract and CONTRACT-017D. Recorded in
`evidence/M0-owner-confirmation.md`.

Standing authority applies: live drills that spend real provider money, staging
redeploys, `polyp-sequence.service` restarts, the single contract commit and
the push all proceed without pausing. `/security-review` runs before the push;
`README.md` is updated at close.

**One authority worth naming rather than assuming.** This drill will execute
code that a model wrote, inside the Docker worker isolation the system was
built around. That is the pipeline operating as designed rather than a new
capability, and it is covered by the live-drill authority — but it is the first
time it happens, so it is stated here in the open instead of buried in a
milestone.

## Scope

- A **drill script** that drives the whole path against staging: conversation →
  proposal → owner approval → blueprint → workspace provisioning → generation
  task → patch execution in an isolated worker → verification gates →
  publication. Re-runnable, and honest about which step it reached.
- **Fixing whatever it hits.** Every defect the drill surfaces is fixed inside
  this contract rather than deferred. That is the contract's real body of work,
  and its size is unknown by nature — the whole point is that nobody has looked.
- **A dummy project worth generating**: small, Node/TS, real. Something with a
  test that can actually pass, so verification means something.
- **Evidence per stage**, so a future session can see where the pipeline stood
  without re-running it.
- **Spend accounted** in the ledger and reported, per the standing rule that
  drill spend is stated rather than tallied silently.

## Out of scope

- **The dashboard.** No screen is built until 017D closes.
- **Multi-stack generation** — CONTRACT-021 owns it. The dummy project is
  Node/TS because that is what `NodeWorkspaceProvisioner` supports today, and
  proving the pipeline must not be entangled with widening it.
- **Reproducibility and unattended operation** — CONTRACT-017D owns those. This
  contract may leave manual steps behind, provided it records every one.
- Releasing the $0.60 held by three `outcome_unknown` ledger rows.
- Public DNS, Cloudflare cutover, production promotion.

## Milestones

0. M0: owner confirmation, recorded above.
1. M1: read the pipeline end to end and write down where it is expected to
   break, before running it. A prediction made in advance is evidence; one made
   afterwards is a story.
2. M2: the drill script, driving conversation → proposal → approval.
3. M3: blueprint → workspace provisioning, against staging.
4. M4: generation task → patch execution in an isolated worker.
5. M5: verification gates → publication, reaching a terminal successful state.
6. M6: the full drill run clean from a standing start; spend reported; README,
   security review, close.

## Gates

- **A generated project on staging in a terminal successful state**, not
  `idea`, with a workspace on disk containing files the factory wrote.
- Its evidence chain is complete: proposal, approval, blueprint version,
  workspace ref, task attempts, gate evidence, publication record.
- Its spend appears in `ai_usage_events` against its own budget scope, and the
  scope's cap was enforced rather than merely present.
- The drill reports the stage it reached, and its report is true — a failure
  says which stage failed and why, and never attributes a failure to a
  component that was never reached.
- Full suite, dashboard suite, `typecheck`, `format:check`, `npm audit`,
  `verify-contract.ts CONTRACT-017C`, `resume-checkpoint.ts --check`, zero
  skips.
- `/security-review` clean, or findings fixed before the push.

## Acceptance

- The owner can point at a project and say the factory built it.
- Every stage of the pipeline has been observed working, not inferred.
- What is still broken is written down, with an owner.

## Rollback

The drill is additive: a script, fixes, and evidence. Reverting the commit
leaves the pipeline exactly as unproven as it is today. Data written to staging
is a generated project in its own namespace, isolated by design from the
control plane.

## Amendment 1 — the essential documents (2026-08-11)

The owner asked, mid-contract, for "every essential necessary document
including PRD, TAD, Design, Resume, and others" to be updated or generated.
That is requested work, so it happens here rather than waiting for a contract
of its own.

**Written:**

- `docs/product/PRD.md` — the five goals as numbered requirements, each marked
  Proven, Unproven, Partial or Absent with the contract that owns the gap. The
  vocabulary is the point: "Unproven" means the code exists, is tested and
  reviewed, and has never run.
- `docs/architecture/TAD.md` — the technical architecture as built: module map,
  the work engine, the gateway's idempotency contract, the generation pipeline
  end to end, isolation, deployment, and the four structural defects M1 found.
- `docs/design/DESIGN.md` — the design decisions the owner confirmed against a
  rendered mockup, the tokens, the layout, the Factory Live reference, and the
  rules that apply to every surface.

**Corrected, because they described infrastructure that was never built:**

- `docs/SYSTEM-SPECIFICATION.md` §5 and §6, and
  `docs/architecture/system.md` — all three named **Redis and BullMQ** as the
  durable job substrate. Neither was ever introduced; `src/work/**` runs on
  PostgreSQL. §6 additionally listed TanStack Query, React Hook Form, Zod,
  Tailwind, Radix/shadcn, Recharts, Drizzle, Pino and OpenTelemetry, none of
  which are in `package.json`. The corrections are marked in place rather than
  made silently, since a specification describing absent infrastructure sends
  the next reader looking for it.

**File ownership is extended accordingly**, below. Recorded here rather than
edited quietly, because `scripts/verify-contract.ts` exists to make exactly
this kind of widening visible.

## File ownership

- `docs/contracts/CONTRACT-017C/**`
- `docs/contracts/CONTRACT-018/**`
- `docs/product/**`
- `docs/architecture/**`
- `docs/design/**`
- `docs/SYSTEM-SPECIFICATION.md`
- `docs/RESUME.md`
- `README.md`
- `CLAUDE.md`
- `migrations/**`
- `src/**`
- `scripts/**`
- `tests/**`
