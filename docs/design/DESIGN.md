# Design — the Master Dashboard

The dashboard is the owner's **primary daily workspace**, not a status page
they visit occasionally. Goal 4 makes performance and aesthetics a product
requirement rather than a finishing touch.

This document holds the decisions. `docs/SYSTEM-SPECIFICATION.md` §20 holds the
information architecture those decisions serve, and `docs/product/PRD.md` §R5
tracks how much of it exists.

## 1. The target, in the owner's words

> "saya ingin dibuat seperti claude.ai baik style maupun fungsinya beserta
> semua fiturnya mulai dari percakapan, history, project, usage, model
> selection, system monitor, visualisasi ketika agent bekerja"
> — 2026-08-11

claude.ai-like in **style and function**: conversation, history, projects,
usage, model selection, system monitor, and the agents visible while they work.
Model selection is explicitly **not vendor-locked** — several providers, each
carrying several models.

Reviewing a rendered mockup before any UI is written is a standing owner
checkpoint, not a courtesy.

## 2. Confirmed decisions

Each was chosen by the owner against a rendered alternative. They are settled
and are **not re-asked** when a contract starts.

| Decision                | Choice                                                       | Date       |
| ----------------------- | ------------------------------------------------------------ | ---------- |
| Palette                 | Unchanged — the existing twelve variables are confirmed      | 2026-08-11 |
| Layout                  | Single column, claude.ai-like, everything else behind a rail | 2026-08-11 |
| Left rail default       | **Collapsed on every screen size**                           | 2026-08-11 |
| Composer                | **Centred**, sharing one measure with the thread             | 2026-08-11 |
| Per-message cost        | **Always visible** under every reply, not behind a hover     | 2026-08-11 |
| Factory Live            | The 3D neural mesh reference, plus Gource-style growth       | 2026-08-11 |
| Typeface and type scale | Deferred to CONTRACT-020, with the rest of the design system | 2026-08-11 |

The palette decision is the load-bearing one: **structure and interaction
change; colour does not.** It also keeps a behaviour contract and a restyling in
separate contracts, so a regression in one can never be mistaken for the other.

## 3. Tokens

The current values, from `src/dashboard/styles.css`. Confirmed, not proposed.

| Token         | Value     | Used for                           |
| ------------- | --------- | ---------------------------------- |
| `--bg`        | `#07101d` | Page ground                        |
| `--surface`   | `#0d1928` | Panels, composer, popovers         |
| `--surface-2` | `#122238` | Raised rows, owner message, chips  |
| `--border`    | `#263b54` | Structural edges                   |
| `--muted`     | `#8fa3ba` | Secondary text                     |
| `--text`      | `#e8eef7` | Primary text                       |
| `--cyan`      | `#53d5ff` | Accent, active state, streaming    |
| `--violet`    | `#9a8cff` | Second accent, delegation          |
| `--green`     | `#45d49a` | Success, live, evidence returning  |
| `--amber`     | `#f4b95f` | Waiting, approval needed, degraded |
| `--red`       | `#ff6f7f` | Failure                            |
| `--radius`    | `18px`    | Container rounding                 |

**Semantic colour is separate from accent.** Green/amber/red mean state and are
never decoration; cyan and violet are the accents and never carry meaning on
their own. State must also be legible without colour — a chip's text says
`running`, not just a green dot.

**Known gap.** Twelve variables, no type scale, and `styles.css` named "DM Sans"
from the dashboard's first commit while never loading it — no `@font-face`, no
link, no asset, so every user has always seen the system UI face. Naming only
what resolves was the honest interim fix; shipping a deliberate typeface is
CONTRACT-020.

## 4. Layout

**One centred measure.** The thread and the composer share a single column of
about 720px, centred in the available width. The composer is not pinned to an
edge — it sits under the conversation it belongs to, which is what makes a chat
feel like a document rather than a form.

**The rail is an icon strip by default**, ~54px, expanding on demand to show
navigation and conversation history. Collapsed is the resting state on every
screen size, by owner decision: the thread gets the room.

**Messages are asymmetric on purpose.** Owner messages are short and bubbled,
capped near 46 characters wide, right-aligned — they scan as punctuation in the
thread. Assistant replies run as plain prose at a comfortable measure with no
bubble, because a container around a long technical answer costs reading width
and buys nothing.

**Per-message attribution sits under the reply**: model, tokens, cost, elapsed
time, then the actions. Numbers use `tabular-nums` so they hold a column.

## 5. Navigation

From `SYSTEM-SPECIFICATION.md` §20, in the order the rail presents them:

Chat · Projects · Factory Live · Usage · System · Settings

The specification's fuller list — Overview, Contracts/Runs, Agents, Providers &
Models, Knowledge & Artifacts, Deployments, Incidents, Approvals, Notifications,
Rules — is not abandoned; it is progressive disclosure. A single owner does not
need eleven top-level destinations, and the ones above are what they use daily.

## 6. Factory Live

The owner named the reference directly: `references/neural-reference-3d.html` in
their `her0ikur0i/polyptech` repository, plus Gource.

That reference is not a new direction — it is the "reviewed Polyptech reference"
§21 was written _from_. What ships today is a flat 2D graph that does not
resemble it.

**What the reference contributes:** a bright core, clusters radiating outward on
their own axes, multi-segment trunks, subgroups and leaf nodes, depth-sorted
edges drawn back-to-front, and drag-to-rotate with inertia. Canvas 2D pseudo-3D
throughout — §21 requires browser-only rendering, and no 3D library is added.

**What Gource contributes:** growth over time. The tree gains nodes as files are
actually written by a run, rather than being drawn once at final size. This is
what makes it a view of work happening rather than a diagram of structure.

**What the data already means**, unchanged from §21: the orchestrator is the
core, trunks are delegation relationships, branches are milestones and tasks,
small nodes are files and evidence, particles outward mean delegation and
returning particles mean evidence. Speed, glow and line state reflect real
busy/idle/success/approval/failure/stale data.

**The performance contract is not relaxed by the visual target.** Caps on nodes,
edges and particles; DPR limited; frame time measured with adaptation across
30/15/5 FPS; paused when hidden or offscreen; a static reduced-motion mode; and
graph topology rebuilt only when structure changes. This runs on 2 vCPU.

**Visualization never controls workflow state.** It is a view.

## 7. Rules that apply everywhere

- **Model output is untrusted in the browser too.** Markdown renders as text;
  raw HTML is never rendered as markup. Proven by tests that feed hostile
  content — script tags, `javascript:` URLs, event-handler attributes — and
  assert what reaches the DOM, rather than trusting a library's reputation.
- **Explicit partial, error and stale states.** A surface that cannot get its
  data says so; it never shows a confident empty state.
- **Never lose what the owner typed.** A failed send keeps the text in the
  composer and says what to do next.
- **Long lists virtualize.** Conversations that CONTRACT-017A made cheap are the
  ones that will get long.
- **Keyboard and screen reader access are requirements**, including a visible
  focus state on everything interactive and a semantic DOM tree beside the
  canvas.
- **Reduced motion is honoured** by every animation, including the mesh.
- **No meaningless charts.** A number that does not change a decision is noise.

## 8. Copy

Written from the owner's side of the screen. A control says what happens
("Stop", then the reply stops). Errors say what went wrong and what to do, with
no apology and no vagueness. Work is named in human terms — what it is plus what
it concerns — and never by uuid; the id appears only where it is needed to act
on something.

That last rule came from CONTRACT-017B, after the owner read a day of their own
Telegram transcript. It applies to every surface, not just Telegram.
