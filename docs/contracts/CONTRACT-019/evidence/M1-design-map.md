# CONTRACT-019 M1 Evidence — Design Map and Work Slices

## Status

M1 is complete.

This milestone consolidates the owner-approved design direction into a concrete
dashboard map and bounded implementation slices. It does not change product
code.

## Source Inputs

Reviewed inputs:

- `docs/design/DESIGN.md`
- `docs/contracts/CONTRACT-018/evidence/M0-owner-confirmation.md`
- `docs/contracts/CONTRACT-018/review/deepseek-refero-ui-domain.html`
- `docs/contracts/CONTRACT-018/review/ledger-ui.html`
- `docs/contracts/CONTRACT-019/contract.md`

Retained external references:

- `https://polyp-ui-review.heroikuroi.chatgpt.site/#deployment`
- `https://claude.ai/code/artifact/386ec810-0571-44ea-9fe8-68c47a880ac9`

The Claude artifact remains treated as owner-provided but potentially
authentication-gated for agents. Local CONTRACT-018 notes and review artifacts
are the usable source of truth when the URL cannot be fetched directly.

## Product Frame

The dashboard is the owner's daily operating workspace. It is not a landing
page, marketing site, or decorative demo.

Design direction:

- whole-app workspace in the claude.ai family of interaction density;
- collapsed left rail available on every screen;
- centered conversation thread and composer for chat/orchestration;
- existing confirmed palette remains unless a later design-system contract
  changes it;
- model, token, cost, elapsed time, and fallback attribution stay visible where
  assistant/model work appears;
- partial, stale, denied, pending approval, and failed states are explicit;
- no fake Factory Live activity;
- long histories and lists are virtualized or paged before they become daily-use
  bottlenecks;
- keyboard, screen reader, reduced-motion, and responsive behavior are first
  class acceptance criteria.

## Navigation Map

The current code already routes:

- `/` Overview
- `/orchestrator`
- `/policy`
- `/factory-live`
- `/projects`
- `/contracts`
- `/agents`
- `/providers`
- `/approvals`
- `/infrastructure`
- `/settings`

CONTRACT-019 should evolve this into the owner-facing map below. Existing routes
may be kept when they are already linked, but labels and grouping should converge
on this vocabulary.

| Route                          | Label        | Primary Job                                                                                                                                                                                                                                                |
| ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                            | Overview     | Show the current operating state: active run, attention items, budget, Telegram health, service health, recent projects, and last meaningful report.                                                                                                       |
| `/orchestrator`                | Chat         | Daily conversation workspace: project context, history, goal clarification, proposal handoff, blueprint/generation actions, attachments, reply progress, and model/cost attribution.                                                                       |
| `/projects`                    | Projects     | Project registry and detail drill-in: lifecycle, blueprint state, generation state, workspace/artifact references, owner actions, and current blockers.                                                                                                    |
| `/contracts` or `/runs`        | Runs         | Contracts, tasks, attempts, evidence, fallback ladder, validations, costs, and deployment state. Prefer adding `/runs` as an alias while keeping `/contracts` for compatibility.                                                                           |
| `/approvals`                   | Approvals    | Owner approval queue with risk, expiry, source, requested action, decision history, and Telegram parity.                                                                                                                                                   |
| `/policy`                      | Policy       | Budget gates, provider eligibility, fallback rules, live probes, approval thresholds, and route simulation.                                                                                                                                                |
| `/providers`                   | Models       | Provider and model catalog, route modes, health, cost, fallback visibility, and manual policy-approved selection.                                                                                                                                          |
| `/telegram`                    | Telegram     | Telegram configuration, health, webhook/poller state, authorized IDs, connectivity test, test message, last report, and report quietness rules. The existing settings section can host this first, but the owner should get a direct Telegram destination. |
| `/factory-live`                | Factory Live | Real-time factory visualization using live topology/events only, with reduced-motion and stale/gap states.                                                                                                                                                 |
| `/infrastructure` or `/system` | System       | Host, services, database, queue, budget, audits, backups, and deployment observations. Prefer adding `/system` as an alias while keeping `/infrastructure` for compatibility.                                                                              |
| `/settings`                    | Settings     | Account-level dashboard settings, authenticated access notes, environment references, and non-secret integration metadata.                                                                                                                                 |

Primary rail order for the daily UI:

1. Overview
2. Chat
3. Projects
4. Runs
5. Approvals
6. Factory Live
7. Models
8. Telegram
9. System
10. Settings

Policy may remain one click from Models or System if space is tight, but the
route must stay addressable.

## Current Implementation Baseline

Observed frontend/backend baseline:

- `src/dashboard/app.tsx` already has BrowserRouter/MemoryRouter support, a
  left navigation shell, lazy pages for Factory Live, Orchestrator, and Policy,
  and registry placeholders for several pages.
- `src/dashboard/conversation-workspace.tsx` already covers conversation,
  proposal, blueprint translation, generation, attachments, history, polling,
  and assistant model attribution.
- `src/dashboard/policy-control.tsx` already exposes policy route editing,
  provider route simulation, and live probe controls.
- `src/dashboard/factory-live/**` already validates snapshots/events and renders
  live topology with gap/stale handling.
- `src/control-api/app.ts` already exposes owner-gated endpoints for dashboard
  snapshot, Telegram settings save, project creation/generation, orchestrator
  proposals/conversations/messages/attachments, reply-task polling/streaming,
  policy, and Factory Live.

Known gaps for later milestones:

- direct `/telegram` route and owner-facing Telegram test/status actions;
- direct `/runs` and `/system` route aliases or label cleanup;
- authenticated hostname cutover evidence for `dash.surachmancenter.com`;
- stronger conversation mode selection for "Clarify goals";
- clearer project-generation stepper and run/evidence linkage;
- model selection UI that shows policy route reason without bypassing gates;
- Factory Live visual polish against real data, not invented nodes;
- responsive/accessibility pass across the full app.

## DeepSeek Work Slices

Each slice is small enough to hand to DeepSeek without a single large milestone.
Codex remains coordinator/reviewer/integrator.

### M2 — Authenticated Access Plan

Owner: Codex, with DeepSeek only if deploy scripts need small edits.

Deliverables:

- document current dashboard service target;
- document Cloudflare Access or equivalent auth route for
  `dash.surachmancenter.com`;
- probe rollback target;
- no raw secrets in git or logs.

Acceptance:

- M2 evidence names exact service, route, auth layer, rollback check, and any
  blocked external condition.

### M3 — Shell and Navigation Polish

Owner: DeepSeek implementation, Codex review.

Deliverables:

- converge rail labels/order to the M1 map;
- add `/runs`, `/telegram`, and `/system` aliases where needed;
- keep existing routes backward-compatible;
- preserve compact/mobile navigation and tests.

Acceptance:

- dashboard route tests cover aliases and primary labels;
- no landing page or card-nested shell rewrite.

### M4 — Telegram Settings and Test Panel

Owner: DeepSeek implementation, Codex review.

Deliverables:

- direct Telegram page;
- config health, webhook/poller state, authorized IDs, secret reference display,
  last report/update status;
- connectivity test and test-message command;
- report quietness rules visible as operational policy, not marketing copy.

Acceptance:

- server-side tests cover bounded escaped test message behavior;
- dashboard tests cover disabled/error/success states;
- delivery failure cannot change task outcome.

### M5 — Conversation Clarification Mode

Owner: DeepSeek implementation, Codex review.

Deliverables:

- conversation mode selector: Auto, Clarify goals, Build, Review, Lowest cost,
  Highest quality, Manual when policy-approved;
- Clarify goals routes DeepSeek Pro first where policy permits;
- visible selected provider/model, route reason, cost, fallback chain.

Acceptance:

- tests prove mode is stored/sent and policy-gated;
- no arbitrary provider bypass.

### M6 — Project Generation Surface

Owner: DeepSeek implementation, Codex review.

Deliverables:

- project-generation stepper from conversation to proposal, approval,
  blueprint translation, generation task, evidence, and artifact links;
- pending/failed/partial states;
- recovery action labels that match backend state.

Acceptance:

- dashboard tests cover happy path and at least one blocked state;
- no generated project public-domain work in this contract.

### M7 — Runs, Attempts, Evidence, and Cost

Owner: DeepSeek implementation, Codex review.

Deliverables:

- richer Runs page from snapshot and any needed narrow API read endpoint;
- task attempts, models, tokens, costs, fallback, validation, evidence, and
  deployment state;
- human labels before UUIDs.

Acceptance:

- tests cover ledger/cost rendering and hidden raw UUID noise in primary labels.

### M8 — Model Policy and Selection UI

Owner: DeepSeek implementation, Codex review.

Deliverables:

- provider/model route catalog;
- route simulator made understandable from the daily UI;
- policy-approved manual selection controls only where allowed.

Acceptance:

- policy and UI tests prove manual selection cannot bypass budget, approvals, or
  verified-failure fallback.

### M9 — Factory Live Real Visualization Pass

Owner: DeepSeek implementation, Codex review.

Deliverables:

- visual refinement using real snapshot/event data;
- activity, stale, gap, and reduced-motion states;
- no fake nodes or fabricated work.

Acceptance:

- dashboard build/test pass;
- visual inspection or screenshot evidence shows real nonblank rendering.

### M10 — Responsive, Accessibility, Loading, and Error Polish

Owner: DeepSeek implementation, Codex review.

Deliverables:

- pass through the implemented pages for mobile, desktop, focus, loading,
  partial, stale, denied, and error states;
- verify no button/card text overflow;
- virtualize or page long lists touched by the contract.

Acceptance:

- dashboard tests plus manual/screenshot evidence for representative desktop
  and mobile views.

### M11 — Live End-to-End Drill

Owner: Codex orchestrates; DeepSeek fixes bounded bugs found by the drill.

Deliverables:

- authenticated dashboard drill from login/access through conversation,
  clarification, project generation, run inspection, model/cost visibility,
  Telegram state, and Factory Live observation.

Acceptance:

- live drill evidence records exact date, hostname, auth state, commands/actions,
  output summary, and any residual risk.

### M12 — Security Review and Close

Owner: Codex.

Deliverables:

- security review;
- README/operations/resume updates;
- final gates;
- deploy and rollback note;
- contract closeout.

Acceptance:

- full zero-skip backend tests, dashboard tests/build, typecheck, format,
  contract verification, resume checkpoint check, and push.

## Risk Register

| Risk                                            | Control                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Dashboard hostname becomes public without auth. | M2 must document and verify the auth layer before live drill.             |
| Telegram settings expose secrets.               | Store/display secret references only; never raw tokens.                   |
| Telegram returns to spammy success reports.     | M4 tests quiet terminal reporting and bounded test messages.              |
| Model selector bypasses policy.                 | M5/M8 must route through policy and tests must cover denied/manual cases. |
| DeepSeek receives an oversized task.            | Keep one milestone per narrow surface and review before merge.            |
| Factory Live becomes decorative/fake.           | M9 must render only validated snapshot/event data.                        |
| Routes break existing links.                    | Add aliases before removing old route names.                              |

## Next Step

Proceed to M2: authenticated `dash.surachmancenter.com` access plan and rollback
probe. No frontend code should be changed before M2 records the safe access
boundary.
