# M0 — Owner confirmation

Date: 2026-08-11. Status: **paused — this contract is deferred behind
CONTRACT-017C and CONTRACT-017D by owner decision. Its decisions are recorded
and carry forward.**

## Round 1 — the mockup, and what it got wrong

The first mockup drew the chat window alone: single column, collapsible rail,
seven behaviours. The owner's verdict was that **the palette is right and the
scope is not**.

> "for the pallet color, yes, but it seems different form expectation. saya
> ingin dibuat seperti claude.ai baik style maupun fungsinya beserta semua
> fiturnya mulai dari percakapan, history, project, usage, model selection,
> system monitor, visualisasi ketika agent bekerja, anda bisa mencari
> catatannya di server. model selection disini tidak vendor lock melainkan
> terdapat beberapa provider, dan pada masing masing provider terdapat pilihan
> model."

So the target is **the whole application**, claude.ai-like in style _and_
function: conversation, history, projects, usage, model selection, system
monitor, and the agents visible while they work. Model selection is explicitly
**not vendor-locked** — several providers, each carrying several models.

### Answered directly

- **Left rail: collapsed everywhere**, not open-on-desktop. The owner chose the
  option that gives the thread maximum room on every screen.
- **Per-message cost: always visible.** Model, tokens, dollars and elapsed time
  stay under every reply rather than hiding behind a hover.
- **Palette: unchanged.** The dashboard's existing twelve colour variables are
  confirmed. What changes is structure and interaction.

## The notes on the server

The owner said the notes were findable rather than restating them, and they
were right — this was already specified and never built:

- **§20 Dashboard information architecture** lists the navigation almost
  exactly as described: Overview, Orchestrator, Factory Live, Projects,
  Contracts/Runs, Agents, **Providers & Models**, Knowledge, **Infrastructure**,
  Deployments/Incidents/Approvals/Settings — plus global search, virtualized
  long lists, progressive disclosure and explicit stale/error states.
- **§13 Model catalog and routing** already defines multi-provider selection
  with the six modes the owner is asking for: Auto Balanced, Lowest Cost,
  Highest Quality, Fastest, Manual, Policy Locked — and requires the UI to
  explain the selection, the rejected candidates, the estimated cost and the
  fallback chain.
- **§12** states the rule this rests on: _no provider or model is hard-coded in
  core logic._
- **§21 Factory Live View** specifies the agent visualization in detail, down
  to particles meaning delegation outward and evidence returning.

None of this is new direction. It is specification the roadmap had distributed
across contracts without ever drawing what the result looks like assembled,
which is why the first mockup could satisfy CONTRACT-018 and still miss what
the owner was picturing.

## Round 2 — the revised mockup

Redrawn as the whole application on the confirmed palette: chat with the rail
collapsed, the rail opened, the multi-provider model picker with routing modes
and a stated fallback chain, Factory Live, Usage, and the System monitor.

Reference links retained for implementation review:

- Codex as orchestrator:
  `https://polyp-ui-review.heroikuroi.chatgpt.site/#deployment`
- Claude as orchestrator:
  `https://claude.ai/code/artifact/386ec810-0571-44ea-9fe8-68c47a880ac9`

**Consequence for scope, recorded rather than absorbed quietly:** three of
these surfaces already have owners on the roadmap — 018 chat, 019 Factory Live,
020 the shell and design system — and **three do not**: Providers & Models,
Usage, and System. Folding six surfaces into CONTRACT-018 would contradict the
owner's own governing principle that large work is split so the result can be
good. The proposal put to them is therefore to keep 018 as chat behaviour and
add three contracts, sequenced after 020.

## Round 3 — two fixes, and a reversal of the whole order

The revised mockup came back "close — changes needed", with two specifics:

- **The composer.** "make it proportional, or make it in the middle like
  yours." Fixed: the thread and the composer now share one centred measure
  instead of the composer hugging the left edge.
- **Factory Live.** "make it like in this repo
  https://github.com/her0ikur0i/polyptech and gource visualization." That
  repository holds `references/neural-reference-3d.html` — the "reviewed
  Polyptech reference" specification §21 was written _from_, and which nothing
  in this codebase has ever resembled. Today's renderer is a flat 2D graph.
  Recorded as an amendment to CONTRACT-019 in the roadmap, since 019 owns
  Factory Live.

And the sequencing answer reversed the roadmap:

> "backend first, make sure everything connected and the pipeline works and
> wild tested it until success generating dummy project, then move to frontend
> and make sure every function and feature works"

## Consequence: this contract is paused, not cancelled

**CONTRACT-018 does not start yet.** CONTRACT-017C (generate a dummy project
for real) and CONTRACT-017D (make that drill reproducible) are inserted ahead
of it. Everything in this charter keeps its content.

The staging database supports the owner's call harder than they knew: seven
generated projects, **all in `idea` state**, zero proposals, zero generation
tasks ever executed. The pipeline this contract would build a control surface
for has never run. Full record in
`docs/contracts/CONTRACT-017C/evidence/M0-owner-confirmation.md`.

The decisions gathered here — collapsed rail, visible cost, unchanged palette,
centred composer — carry forward and apply unchanged when this contract starts.
They are not re-asked.

## Standing authority

Unchanged and not re-asked: staging redeploy, the single contract commit and
the push proceed without pausing once gates are green; `/security-review` runs
before the push; `README.md` is updated at close. Still excluded: public DNS,
Cloudflare cutover, public hostname exposure, production promotion,
`polyptech-dashboard.service`, and anything secret-impacting or irreversible.
