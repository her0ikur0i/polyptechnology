# Roadmap — CONTRACT-015 through CONTRACT-022

Written 2026-08-09, immediately after CONTRACT-014 was pushed (`f58a649`) and
the repository-wide audit in
`docs/contracts/CONTRACT-015/audit-2026-08-09.md` was completed.

This roadmap exists because the owner asked for every audit recommendation to
be bundled into milestones, and then — on seeing the resulting size — set the
governing principle: **break large work into smaller pieces so the result can
be good** ("pecah pekerjaan besar menjadi lebih kecil agar hasil bisa
berkualitas"). So the recommendations are all here, but distributed across
small contracts rather than compressed into one large one. Each closes with its
own commit and push, so no contract holds a large body of finished work hostage
to an unfinished one.

The sequence has grown since it was written, and deliberately: CONTRACT-016 was
descoped mid-flight and CONTRACT-017 inserted, both because the owner
reprioritised Telegram. That is the mechanism working, not drift — a roadmap
that cannot absorb a change of priority just becomes a document nobody
consults.

## Where the product actually stands

Measured against the owner's five stated goals, not against the contract log.

| #   | Goal                                                                               | Today                                                                                                                                                                                      | Gap owner             |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 1   | Multi-provider factory generating anything from a landing page to a complex system | Three real provider adapters and a working blueprint → workspace → patch → verify pipeline, but `NodeWorkspaceProvisioner` scaffolds **only** Node/TS and hard-rejects every other runtime | CONTRACT-021          |
| 2   | Dashboard whose flagship is a claude.ai-class chat window                          | Chat works end to end — send, background reply, attachments, proposal, approve, generate — but polls every 1.5 s and renders replies as raw text                                           | CONTRACT-018          |
| 3   | Don't reinvent the wheel; standard engineering practice                            | The strongest area: ADRs, threat model, per-contract security review, ordered migrations, CSRF matrices, axe tests, mechanical format gate, zero `npm audit` findings                      | maintained throughout |
| 4   | Maximum performance and aesthetics — this is the primary workspace                 | 718 lines of hand-written CSS, dark-only, 12 colour variables, no type scale, and a declared typeface that has never loaded                                                                | CONTRACT-020          |
| 5   | Every generated product gets its own domain and can be detached                    | Absent from code **and** from the specification. Only logical isolation exists (`workspace://projects/{id}`, separate repos/secrets/budgets)                                               | CONTRACT-022          |
| —   | Seeing the agents actually work (specification §21, ADR-0004, release criterion 8) | A well-built Canvas renderer with **no server behind it** — both routes it calls are unregistered, and every test feeds it a fixture                                                       | CONTRACT-019          |

## Conventions that apply to every contract here

**One batched confirmation milestone, and it runs first.** Every contract opens
with M0, its only owner checkpoint: scope approval, any record correction,
advance approval for the staging redeploy, and advance approval to commit and
push the single resulting commit once every gate is green. Nothing after M0
pauses for owner input. This placement is the owner's explicit direction
(2026-08-09) — confirmations at the front so execution runs smoothly, rather
than a gate at the end that the work queues up behind. If a later milestone
discovers work needing an authority M0 did not grant, that work defers to the
next contract instead of interrupting the current one.

**Model escalation matched to task weight.** Orchestration mirrors the policy
the codebase already enforces on itself (`src/policy/execution-permission.ts`,
`src/gateway/model-policy.ts`): cheapest viable tier first, escalating only on
verified failure evidence, never by default. Mechanical, spec-driven milestones
(dead-code removal, formatting, doc scaffolding, test transcription) run on the
cheapest tier that can complete them; architecture, security review, and final
gates run at the top tier. A transport failure retries the same tier rather
than escalating.

**Ceremony scaled to risk.** Milestones touching money, secrets, code
execution, or approval boundaries keep the full treatment including independent
security review. Purely presentational milestones do not.

**Resource ceiling.** 2 vCPU, 7.8 GB RAM, 80 GB disk. Heavy verification
(Docker plus Postgres) runs serially, never in parallel. No proposal in this
roadmap needs more machine than that — which is also why none of them involve
Kubernetes, a service mesh, or multi-node anything, consistent with
`docs/SYSTEM-SPECIFICATION.md` §11.

---

## CONTRACT-015 — Foundation hardening

Fully specified in `docs/contracts/CONTRACT-015/contract.md`. Ships no
user-facing feature deliberately: it removes a competing provider abstraction
that nothing imports, collapses three copies of the path-traversal guard into
one, stops serving the dashboard's own source to the browser, and adds the
request throttle the control plane has never had. Everything after this builds
on these files.

Nine milestones, closing with the batched owner confirmation gate.

## CONTRACT-016 — Streaming foundation (closed)

Descoped by its own Amendment 1 when the owner asked for Telegram to be
prioritised, and closed on what was already built and working rather than left
to absorb a new priority. Delivered: a real streaming path through the provider
layer (`ClaudeCliAdapter` over `spawn` with `--output-format stream-json`),
durable reply chunks that cross the process boundary between
`polyp-sequence.service` and the Control API, and a coalescing writer that turns
per-token deltas into a sane number of database writes.

The governing principle, which everything downstream inherits: **accumulated
fragments are never the answer.** `ManagedCompletion.content` is the only source
of truth, chunks are disposable progress. That is why a stream dying mid-answer
leaves no half-written record, why ledger settlement is unchanged, and why the
machinery could ship inert without risk.

## CONTRACT-017 — Telegram as a working control surface

**Objective.** Reports, approvals, conversation and commands over Telegram —
prioritised ahead of the rest of the chat work at the owner's explicit request
(2026-08-10). Fully specified in `docs/contracts/CONTRACT-017/contract.md`.

The finding that makes it possible now: Telegram's webhook transport needs a
public HTTPS endpoint, which this deployment does not have and will not have
until CONTRACT-022's cutover. **Long polling (`getUpdates`) is outbound**, so
inbound Telegram needs no public exposure, no DNS change, and no new trust
boundary. Verified against the live bot before drafting.

The authority boundary it will not bend: a Telegram-originated message gains
exactly the authority the same message typed into the dashboard would gain, and
not one step more. Commands are therefore a **closed set** — status, active
runs, pending approvals, budget, and answering decisions that already exist —
confirmed sufficient by the owner. Nothing executes because it was asked for in
a chat.

## CONTRACT-018 — Chat experience on the streaming foundation

**Objective.** What CONTRACT-016 was originally going to carry, now built on the
foundation it laid: the Control API SSE route with resume-from-last-chunk, the
client that consumes it and renders progressively, markdown with
syntax-highlighted code blocks and per-block copy, a real composer
(autosize, Enter/Shift+Enter, stop, regenerate, edit-and-resend, optimistic
echo, error recovery that preserves typed text), per-message model attribution
and cost from the ledger, and virtualized thread rendering.

Rendering model output is an injection surface: it must not be able to inject
HTML, script, or styling into the dashboard, and that is proven by test with
hostile content rather than assumed from the library's reputation.

**Excludes.** The design-system replacement (CONTRACT-020) — this contract
delivers behaviour on the current visual language, so a behaviour regression and
a restyling can never be confused for one another.

## CONTRACT-019 — Factory Live: the agents at work, for real

**Objective.** Give the visual agent view an actual server. Added to the
roadmap at the owner's direction (2026-08-09), with the standing instruction
that it must be real: _"tentu saja nyata, we're doing real work here, not
dummy."_

The audit found that `src/dashboard/factory-live/api.ts` calls
`/api/v1/factory-live/snapshot` and `/api/v1/factory-live/events`, and that
neither route exists on the server. What already exists is genuinely good and
is not being rebuilt: the Canvas 2D renderer, the deterministic layout rebuild
keyed on `structureVersion`, monotonic event IDs with gap detection, the caps
on nodes/edges/particles/DPR, the 30/15/5 FPS frame-budget controller, the
pause-when-hidden behaviour, the reduced-motion static fallback, and the
parallel semantic DOM tree — all specified in
`docs/architecture/adr-0004-factory-live-rendering.md` and
`docs/SYSTEM-SPECIFICATION.md` §21. What is missing is everything behind them.

- A snapshot route and an SSE event route, carrying the same owner
  authentication and project-scope filtering as every other Control API route.
- A real projection from durable state into the `LiveNode`/`LiveEdge`/
  `LiveEvent` shapes the client already validates: work-engine leases and
  fencing, task attempts and their outcomes, gateway routing decisions
  including which tier is executing and why it escalated, approval waits, and
  verification-gate results. The drill-down the specification defines —
  factory → project → contract → milestone → **agent** → task/file — is
  populated from records that already exist; nothing here invents new data.
- Monotonic sequencing that survives reconnects and process restarts, so the
  client's existing gap-recovery path is exercised by real gaps rather than
  simulated ones.
- Replacement of fixture-only test coverage: `tests/dashboard/factory-live.test.tsx`
  keeps its fixture-driven renderer tests, and new integration tests drive the
  real producer end to end.
- Genuine re-verification of release criterion 8 against the real producer.
  CONTRACT-015 M0 corrects the record in
  `docs/contracts/CONTRACT-010/acceptance-matrix.md` to state what is actually
  true today; this contract is what earns the `Verified` back.

**Excludes.** Any change to the renderer's visual language — that belongs to
CONTRACT-018, and keeping them apart means a rendering regression and a
producer bug can never be confused for one another. Replay of historical
streams beyond what the current client already supports.

## CONTRACT-020 — Design system and shell

**Objective.** Goal 4, treated as the primary-workspace requirement the owner
stated rather than as a cosmetic pass.

Direction agreed from the mockup published 2026-08-09: a precision console
rather than a glowing application — warm-neutral grounds, one flat ink accent
with no glow or gradient, semantic colour reserved strictly for gate state,
monospace as a real structural voice for identifiers, costs, routes, and
domains.

- A complete token layer: colour, spacing, typography scale, radius, elevation,
  motion.
- Light and dark both designed as first-class, not one inverted from the other.
- Component consistency across all pages, and a real typographic hierarchy.
- The two honest placeholder pages, `/infrastructure` and `/agents`, filled in
  — open since before CONTRACT-014 and confirmed by the owner as candidates.
- Contrast verified against WCAG AA on the real token values, extending the
  axe coverage that already exists.

**Excludes.** Chat behaviour (CONTRACT-016 owns it). Any new page beyond the
two existing placeholders.

## CONTRACT-021 — Multi-stack generation

**Objective.** Goal 1's actual ceiling. Today `src/factory/workspace-provisioner.ts:30`
rejects any blueprint whose runtime is not `node`, and
`src/operations/verification-image-policy.ts` pins exactly one verification
image — so the factory cannot currently produce the landing page the owner
named as its simplest case.

- A stack registry replacing the single hard-coded scaffold: static site, SPA,
  and Node service to start.
- Per-stack verification images and command chains, replacing the single pinned
  image, keeping the fail-closed behaviour for unknown stacks.
- The Docker worker suite running in CI, which the audit found it never has —
  natural to land here, since this contract is what multiplies the images.

**Excludes.** Deployment and domains (CONTRACT-021). Any stack beyond the three
named, until a real blueprint demands it.

## CONTRACT-022 — Domain and detach

**Objective.** Goal 5, which exists in neither code nor specification today.
Requires a new ADR before implementation, because it introduces the first
component that serves traffic for something other than the control plane.

- Per-project domain allocation under a wildcard the factory already controls,
  so no DNS action is needed per generated product.
- Reverse-proxy routing to per-project units, with health and rollback visible
  on the product's own row in the registry.
- A real detach flow: repository exported with history, secrets revoked and
  rotated rather than copied, domain released or reassigned, budget closed
  while the cost record stays permanent.
- The Cloudflare Access JWT verification that CONTRACT-013 M8 left as an
  interim loopback-bind guarantee — this is the contract where it stops being
  deferrable, since it is the one that contemplates public traffic.

**Owner decision already recorded (2026-08-09):** build the full capability,
verified against loopback and a local test domain; **the public DNS cutover and
real internet exposure stay out of scope**, deferred to this contract's batched
confirmation milestone. The orphaned `polyptech-dashboard.service` still
occupying `dash.surachmancenter.com` is a decision for that same checkpoint and
must not be touched before it.

### Closing milestone — the full-factory acceptance drill

Added at the owner's direction (2026-08-09): once development is judged final,
the last milestone of this last contract is a real end-to-end run of the AI
Factory generating a simple project, **exercising every registered provider and
model** rather than a single routing tier.

This is the drill twice deferred already — CONTRACT-013 M9 and CONTRACT-014 M9
both recorded a "real-provider-credentialed drill" as outstanding — and this is
where it stops being deferred. What makes it different from every prior
acceptance test is that nothing is faked: real credentials, real provider
calls, real spend against a real budget, a real workspace, real verification in
a real container, and a real domain allocated by the capability this contract
builds.

Requirements it imposes on the run:

- every provider in the registry is invoked at least once — DeepSeek, Codex,
  and Claude — and every model listed for them in `src/gateway/model-policy.ts`
  is exercised across the task classes that route to it;
- the escalation ladder is observed under real conditions, including at least
  one genuine escalation driven by verified failure evidence rather than a
  forced one;
- per-provider, per-model cost and token attribution reconciles against the
  gateway ledger, with the totals recorded in the evidence;
- the generated project reaches a working, reachable state on its own domain,
  and is then detached cleanly.

**Prerequisite outside the advance-authority grant:** the drill needs live
provider credentials to be present. Supplying or rotating those is a
secret-impacting action, which
`docs/contracts/CONTRACT-015/evidence/M0-owner-confirmation.md` §2 explicitly
excludes from the standing authority. If the credentials are not already in
place when this milestone is reached, that is the one point where the roadmap
pauses for the owner.

---

## Deliberately not scheduled

- Reconciling CONTRACT-008's `outcome_unknown` ledger attempt
  (`66717047-593d-4976-b133-0a04d475e341`) — it matters only to whichever
  database becomes production, which no contract has designated yet.
- Additional AI providers beyond the three wired today. Three is enough to
  prove routing and escalation; a fourth adds cost and surface without
  answering a question the current three leave open.
- Kubernetes, multi-node HA, plugin marketplace, ML-based routing — excluded by
  `docs/SYSTEM-SPECIFICATION.md` §11 and by the machine this runs on.
