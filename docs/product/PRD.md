# Product requirements — Polyp AI Factory

Owner: a single operator. Audience: whoever picks this repository up next,
including a future session of the assistant.

This document says **what the product must do and how far along each
requirement actually is.** It is deliberately not a status report written to
look good: a requirement whose code exists but has never run is marked as
unproven, because the difference between those two states is the most expensive
thing this project has learned.

Companion documents:

- `docs/SYSTEM-SPECIFICATION.md` — the master specification, numbered by
  section. Where this file and that one disagree about intent, that one wins.
- `docs/architecture/TAD.md` — how it is built.
- `docs/design/DESIGN.md` — what it looks like and why.
- `docs/product/roadmap-2026H2.md` — the order of work.
- `docs/RESUME.md` — current delivery state. Always the freshest.

## 1. The product in one paragraph

Polyp is a single-owner AI software factory. The owner talks to it; it turns
that conversation into an approved contract, delegates bounded work to AI
agents across several providers, verifies the results mechanically, and
operates the generated projects — which stay isolated from the control plane
and can eventually be detached and handed over. The Master Dashboard is the
control plane's face, and the owner's primary daily workspace.

## 2. Goals, as the owner stated them

Stated 2026-08-09, unchanged since. Every requirement below traces to one.

| #   | Goal                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- |
| G1  | A web app powered by multiple AI providers that generates anything from a landing page to a complex system |
| G2  | A dashboard whose flagship feature is a chat window comparable to claude.ai                                |
| G3  | Do not reinvent the wheel; use proven technology; keep standard engineering practice                       |
| G4  | Maximum performance and aesthetics — the dashboard is the primary daily workspace                          |
| G5  | Every generated product gets its own access domain and can be detached when finished                       |

## 3. Status vocabulary

Used strictly, because the whole value of this document is that these words
mean different things.

| Word         | Means                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| **Proven**   | Observed working against real data, with evidence recorded             |
| **Unproven** | Code exists, is unit-tested and reviewed, and has never run end to end |
| **Partial**  | Works for some inputs and is known to reject or ignore others          |
| **Absent**   | Not built                                                              |

**"Unproven" is not a synonym for "nearly done."** CONTRACT-017A shipped a
feature whose every unit test passed while the feature did nothing at all, and
CONTRACT-017C exists because the entire generation pipeline turned out to be in
that state.

## 4. Requirements

### R1 — Conversation (G2)

| ID   | Requirement                                                                               | Status   | Owner     |
| ---- | ----------------------------------------------------------------------------------------- | -------- | --------- |
| R1.1 | The owner holds a durable, multi-turn conversation with an assistant                      | Proven   | 014, 017A |
| R1.2 | A turn resumes the provider's session rather than replaying the transcript                | Proven   | 017A      |
| R1.3 | Attachments carry into conversation context with provenance                               | Unproven | 014       |
| R1.4 | Replies stream to the client as they are produced, resuming after a dropped connection    | Absent   | 018       |
| R1.5 | Model output renders as markdown and can never inject markup or script into the dashboard | Absent   | 018       |
| R1.6 | A failed send preserves what the owner typed                                              | Absent   | 018       |
| R1.7 | Every reply shows which model answered and what it cost, read from the ledger             | Absent   | 018       |

**R1.2 measured:** 2 fresh input tokens on a resumed turn against ~2,500 on a
cold start, from `ai_usage_events`.

### R2 — Generation (G1)

The product's reason for existing. Until 2026-08-11 it was also its least
evidenced area: the pipeline had never run once.

| ID   | Requirement                                                                       | Status     | Owner |
| ---- | --------------------------------------------------------------------------------- | ---------- | ----- |
| R2.1 | A conversation becomes a proposal the owner explicitly approves                   | **Proven** | 017C  |
| R2.2 | An approved proposal becomes a validated blueprint                                | **Proven** | 017C  |
| R2.3 | A blueprint provisions a real, isolated, git-initialised workspace                | **Proven** | 017C  |
| R2.4 | A generation task produces a patch from a real provider call                      | **Proven** | 017C  |
| R2.5 | The patch is applied and verified in an isolated container before acceptance      | **Proven** | 017C  |
| R2.6 | A failed attempt escalates to the next provider tier on verified failure evidence | **Proven** | 017C  |
| R2.7 | A generated project reaches a terminal successful lifecycle state                 | **Proven** | 017C  |
| R2.8 | The whole path runs unattended and reproducibly from a clean database             | Partial    | 017D  |
| R2.9 | Generation supports runtimes other than Node/TypeScript                           | Absent     | 021   |

**As of 2026-08-11 the factory generates software end to end.** Two consecutive
deep-drill runs took a brief through conversation → proposal → approval →
blueprint → workspace → generation → verification → publication, with nothing
human after the brief, and produced two different correct implementations that
pass their own gates and ten independent behaviour cases each.

Both accepted on `deepseek-v4-flash`, the cheapest tier. An earlier run
escalated `deepseek-v4-flash → deepseek-v4-pro → codex:gpt-5.6-terra` before
acceptance, so R2.6 is proven in both directions.

R2.8 is **Partial** rather than Proven: the drill is repeatable and was run many
times, but not yet from a genuinely clean database with nothing else queued.
CONTRACT-017D owns that.

Nine defects stood between the code and a single successful run, every one
found by running it. Analysis in
`docs/contracts/CONTRACT-017C/evidence/M1-predicted-failures.md` and the M2–M6
evidence beside it. The three worth carrying:

- **The verification sandbox had never seen a file.** `PrivateTmp=yes` on the
  supervisor meant Docker bind-mounted a host path that did not exist, so every
  verification in this system's history ran against an empty directory.
- **The escalation chain could not leave tier one**, because with no owner
  policy active the route resolver returned the same fallback forever.
- **A missing trailing newline** made models' correct diffs unapplicable.

### R3 — Multi-provider routing (G1, G3)

| ID   | Requirement                                                                       | Status     | Owner     |
| ---- | --------------------------------------------------------------------------------- | ---------- | --------- |
| R3.1 | No provider or model is hard-coded in core logic                                  | Proven     | 011       |
| R3.2 | Cheapest viable tier runs first; escalation needs verified failure evidence       | **Proven** | 011, 017C |
| R3.3 | Every call is reserved, settled and attributed in a durable ledger                | Proven     | 011, 017C |
| R3.4 | Budgets exist per scope and produce an explicit blocked state, never silent spend | Proven     | 011, 017C |
| R3.5 | The owner selects among providers and models, with routing modes                  | Absent     | new       |
| R3.6 | The UI explains why a model was chosen, what was rejected, and the fallback chain | Absent     | new       |

R3.2 was Proven for conversation replies and Broken for generation — the same
mechanism, fixed in one caller only. CONTRACT-017C closed that, and the chain
has since been observed walking `deepseek-v4-flash → deepseek-v4-pro →
codex:gpt-5.6-terra` to an acceptance, and stopping at tier one when tier one
succeeds.

**R3.3 and R3.4 carry a correction.** The ledger recorded per-token dollar
costs for **every** provider, including the two reached over subscription
plans, where no such charge exists. The Claude CLI reports what its tokens
would have cost on metered pricing and the gateway banked it, so 97% of
recorded spend was money nobody paid — and it exhausted real budget scopes,
refusing runs that had spent a third of a cent. Providers now declare how they
actually bill (`src/gateway/provider-billing.ts`); subscription completions
keep their token counts and lose the imaginary dollars. Found by the owner
comparing a Telegram report against the providers' own dashboards.

R3.5/R3.6 are specified in `SYSTEM-SPECIFICATION.md` §13 with six modes — Auto
Balanced, Lowest Cost, Highest Quality, Fastest, Manual, Policy Locked — and
have no implementation. Added to the roadmap 2026-08-11 at the owner's request
for model selection without vendor lock.

### R4 — Control and safety (G3)

| ID   | Requirement                                                                         | Status   | Owner |
| ---- | ----------------------------------------------------------------------------------- | -------- | ----- |
| R4.1 | Model output is untrusted; nothing reaches the generation pipeline without approval | Proven   | 011   |
| R4.2 | Work survives API, worker and host restarts without duplication                     | Proven   | 011   |
| R4.3 | Dangerous actions require a valid scoped approval                                   | Proven   | 013   |
| R4.4 | Emergency stop prevents new jobs and drains active work                             | Unproven | 011   |
| R4.5 | Code execution is isolated in a hardened container with no network by default       | Proven   | 013   |
| R4.6 | Backup and restore recreate durable state in a clean environment                    | Unproven | 013   |
| R4.7 | Cloudflare Access JWTs are verified at the application layer                        | Absent   | 020   |

R4.7 is currently substituted by a loopback bind in `src/config.ts` — a
network-level guarantee standing in for an application-level one. Acceptable
only while the deployment is private.

### R5 — Operating surfaces (G2, G4)

| ID   | Requirement                                                          | Status     | Owner      |
| ---- | -------------------------------------------------------------------- | ---------- | ---------- |
| R5.1 | Telegram delivers reports, approvals, conversation and commands      | Proven     | 017        |
| R5.2 | Reports state terminal outcomes only and never contradict the ledger | Proven     | 017B, 017C |
| R5.3 | Factory Live shows agents working, from real data                    | **Absent** | 019        |
| R5.4 | A usage surface shows spend per scope, model and turn                | Absent     | new        |
| R5.5 | A system surface shows host, services and databases                  | Absent     | new        |
| R5.6 | The dashboard shell matches the information architecture in §20      | Absent     | 020        |

R5.3 is the sharpest example of the vocabulary in §3: the Canvas renderer is
well built and fully tested — against fixtures. Both routes it calls are
unregistered. The suite is green and the feature cannot function.

### R6 — Isolation and detachment (G5)

| ID   | Requirement                                                          | Status | Owner |
| ---- | -------------------------------------------------------------------- | ------ | ----- |
| R6.1 | Each project has its own repository, secrets, budget and namespace   | Proven | 013   |
| R6.2 | Each generated product gets its own access domain                    | Absent | 022   |
| R6.3 | A finished product can be detached and handed over, and stay working | Absent | 022   |

G5 existed in neither code nor specification as of 2026-08-09. The owner chose
to build the capability while the public DNS cutover stays deferred.

### R7 — Craft (G3, G4)

| ID   | Requirement                                                   | Status | Owner      |
| ---- | ------------------------------------------------------------- | ------ | ---------- |
| R7.1 | Formatting is a mechanical gate, not a matter of taste        | Proven | maintained |
| R7.2 | Every contract closes with a security review before its push  | Proven | maintained |
| R7.3 | Migrations are forward-only and applied in filename order     | Proven | maintained |
| R7.4 | Dependencies carry no known vulnerabilities                   | Proven | maintained |
| R7.5 | The dashboard has a real type scale and a typeface that loads | Absent | 020        |

R7.5: `styles.css` named "DM Sans" from the dashboard's first commit and never
loaded it — no `@font-face`, no link, no asset. Every user has always seen the
system UI face while the stylesheet claimed otherwise.

## 5. Non-functional constraints

- **Host ceiling:** 2 vCPU, 7.8 GB RAM, 80 GB disk. Heavy verification runs
  serially. Nothing multi-node is ever proposed; this rules out Kubernetes, a
  service mesh, and clustered anything.
- **Single owner.** No multi-tenancy, no organisation billing, no RBAC beyond
  the owner and the services.
- **Private by default.** No public hostname exposure, DNS or Cloudflare
  cutover, or production promotion without fresh owner approval at the time.
- **Cost discipline.** Every provider call is capped per attempt, task,
  milestone, contract and project. Reaching a cap is an explicit blocked state.

## 6. What "done" means for the first release

The twelve scenarios in `docs/product/release-criteria.md`. Two of them —
criterion 8 (Factory Live on real events) and the generation path underpinning
criteria 4–6 — are currently recorded against fixture-fed or unexecuted
evidence. CONTRACT-017C and CONTRACT-019 are what earn them honestly.

## 7. Explicit non-goals

Carried from `docs/product/vision.md` and unchanged: Kubernetes, multi-node
high availability, a public plugin marketplace, fine-tuning proprietary models,
ML-based routing, autonomous production or DNS mutation without human approval,
multi-organisation billing, and native mobile applications.
