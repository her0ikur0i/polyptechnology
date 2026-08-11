# M0 — Owner confirmation

Date: 2026-08-11. Status: **done**. The contract's only owner checkpoint.

## The direction

Given after the owner reviewed a rendered mockup of the whole dashboard:

> "backend first, make sure everything connected and the pipeline works and
> wild tested it until success generating dummy project, then move to frontend
> and make sure every function and feature works"

This reverses the roadmap's order. CONTRACT-018 (chat), 019 (Factory Live) and
020 (shell) all keep their content and move down the queue behind this contract
and CONTRACT-017D.

## Why the direction was right, in numbers the owner did not have

The owner gave this instruction from judgement. Checking it against the real
staging database the same day found harder support than the instruction claimed:

| Question                            | Answer                                                |
| ----------------------------------- | ----------------------------------------------------- |
| Generated projects on staging       | 7                                                     |
| …in a state past `idea`             | **0**                                                 |
| Conversation proposals ever created | **0**                                                 |
| Generation tasks ever executed      | **0**                                                 |
| Drivers that have ever run          | `conversation_reply` (24), `deterministic_sha256` (2) |

Every project on staging is a shell created when a conversation started.
Nothing has ever crossed from conversation into a generated product, so goal 1
is entirely unevidenced and CONTRACT-013's "complete generation pipeline"
describes code rather than a demonstrated capability.

Recorded plainly because it is a correction to this project's own record, not
a discovery about a dependency.

## Decisions taken without asking

Ordinary scope and sequencing, decided and reported rather than referred back:

- **Split into two contracts, not one.** 017C reaches a first successful
  generation; 017D makes it reproducible and unattended. One contract holding
  both would hold a working pipeline hostage to a hardening milestone, against
  the standing rule that contracts stay small.
- **The dummy project is Node/TS.** `NodeWorkspaceProvisioner` supports only
  Node/TS and hard-rejects everything else; widening it is CONTRACT-021's job.
  Proving the pipeline must not be entangled with widening it.
- **M1 writes down where the pipeline is expected to break before it is run.**
  A prediction made in advance is evidence about the system; one made
  afterwards is a story about the author.

## Answers carried from the mockup review

Recorded here because they govern CONTRACT-018 when it starts, and the review
that produced them happened during this contract's M0:

- **Left rail starts collapsed on every screen size.**
- **Per-message cost stays visible** under every reply.
- **Palette unchanged** — the existing twelve variables are confirmed. What
  changes is structure and interaction.
- **The composer is centred**, sharing one measure with the thread.
- **Factory Live follows `references/neural-reference-3d.html`** from the
  owner's `her0ikur0i/polyptech` repository, plus Gource-style growth. Recorded
  as an amendment to CONTRACT-019 in the roadmap.

## Authority

Standing authority applies unchanged: live drills spending real provider money,
staging redeploys, `polyp-sequence.service` restarts, the single contract
commit and the push all proceed without pausing once gates are green.

**Stated in the open rather than assumed:** this drill executes code a model
wrote, inside the Docker worker isolation the system was designed around. That
is the pipeline operating as intended rather than a new capability, and it sits
inside the live-drill authority — but it is the first time it will happen, so
it is named here instead of appearing without warning in a milestone.

Still excluded, still needing fresh approval: public DNS, Cloudflare cutover,
public hostname exposure, production promotion, `polyptech-dashboard.service`,
and anything secret-impacting or irreversible.
