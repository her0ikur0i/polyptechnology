# CONTRACT-019 — Dashboard completion and authenticated access

## Objective

Make the Master Dashboard the owner's daily operating surface and put it behind
authenticated access at `https://dash.surachmancenter.com`.

This contract exists because CONTRACT-018 made the chat surface work, but the
owner's requested frontend is the whole application: conversation, history,
projects, usage, model selection, system monitor, Telegram operations, project
generation, and visible agent work. It also records the operating constraint for
this contract: DeepSeek is the main implementation worker, while Codex stays as
strategist, reviewer, integrator, and final gatekeeper so usage lasts through
the work.

## Operating Model

- **DeepSeek main worker.** DeepSeek Pro/Flash does the bulk implementation:
  dashboard pages, components, styling, focused API additions, and local tests.
- **Codex low-usage coordinator.** Codex owns contract framing, task slicing,
  code review, integration, gates, deployment judgement, and security review.
- **Small tasks only.** No milestone may be a large omnibus UI rewrite. Each
  milestone must be narrow enough to hand to DeepSeek as a bounded task and
  verify independently.
- **Fallback discipline unchanged.** Codex/Claude are not used for bulk coding
  unless DeepSeek is blocked by a verified failure and the owner-approved policy
  allows fallback.

## Design Sources

The visual direction is not invented in this contract. It is assembled from the
owner-reviewed references already recorded in CONTRACT-018:

- `https://polyp-ui-review.heroikuroi.chatgpt.site/#deployment`
- `https://claude.ai/code/artifact/386ec810-0571-44ea-9fe8-68c47a880ac9`
- `docs/contracts/CONTRACT-018/review/deepseek-refero-ui-domain.html`
- `docs/contracts/CONTRACT-018/review/deepseek-ui-extreme.html`
- `docs/contracts/CONTRACT-018/review/ledger-ui.html`
- `docs/design/DESIGN.md`

The Claude artifact may be authentication-gated for agents; when it cannot be
fetched directly, the local M0 notes and retained review artifacts are the
source of truth.

Design constraints:

- Claude.ai-like whole-app workspace, not a marketing page.
- Collapsed left rail by default on every screen.
- Centered conversation thread and composer measure.
- Existing confirmed palette remains unless a later design-system contract
  explicitly replaces it.
- Model, tokens, cost, and elapsed time remain visible under assistant replies.
- Multi-provider model selection is policy-governed, never vendor-locked.
- Factory Live moves toward the owner-provided Polyptech/Gource-style reference
  without faking data.

## Access and Authentication

Target access is `https://dash.surachmancenter.com` with authentication.

Authority granted in M0 covers this hostname only:

- putting the current Master Dashboard behind `dash.surachmancenter.com`;
- configuring authentication in front of it, preferably Cloudflare Access;
- changing or bypassing the old `polyptech-dashboard.service` only as required
  for this hostname cutover;
- staging redeploys, service restarts, and rollback proof.

Still excluded without fresh approval:

- public exposure beyond `dash.surachmancenter.com`;
- production data promotion;
- unrelated DNS changes;
- secret disclosure or storing raw secrets in git;
- changes to generated project public domains.

## Telegram Rules

Telegram is an operational companion, not the primary UI.

Reports must be:

- terminal and meaningful, not internal success spam;
- human-readable, with a title, subject, and short summary;
- bounded so Telegram length limits cannot silence a failure;
- escaped and text-only where appropriate;
- enriched with model, tokens, cost, budget, attempts, and fallback path only
  when those facts help the owner act;
- free of raw UUIDs as primary labels when a human label exists or can be
  omitted;
- failure-safe: Telegram delivery failures never change task outcomes.

Dashboard Telegram settings must support:

- bot token secret reference;
- authorized chat IDs and user IDs;
- configuration health;
- poller/webhook state;
- connectivity test;
- test message;
- last report / last update status.

Telegram `/status`, `/runs`, `/approvals`, and `/budget` must agree with the
dashboard's visible state.

## Model Selection and Clarification

Conversation model choice is policy-governed.

The UI may expose modes, not arbitrary unsafe bypasses:

- Auto;
- Clarify goals;
- Build;
- Review;
- Lowest cost;
- Highest quality;
- Manual, only through policy-approved controls.

For goal clarification, the route should prefer a strong DeepSeek model first
(`deepseek-v4-pro`) before any expensive fallback. The UI must explain the
selected provider/model, route reason, estimated or actual cost, and fallback
chain. Manual selection must not bypass verified-failure escalation, approval
rules, or budget gates.

## Scope

- Dashboard shell and information architecture for the owner workspace:
  Overview, Orchestrator, Projects, Runs, Approvals, Policy, Providers &
  Models, Telegram, Usage/System, Factory Live, and Settings.
- Authenticated access at `dash.surachmancenter.com`, with rollback.
- Telegram settings and test surface.
- Conversation clarification mode and policy-governed model controls.
- Project generation flow from conversation/proposal through blueprint,
  generation, evidence, and run state.
- Runs/attempts/model-cost views that match ledger and Telegram reports.
- Factory Live first real data pass sufficient to show actual work without
  inventing activity.
- Responsive/accessibility/loading/error polish for the implemented surfaces.
- Documentation, live drill evidence, security review, and closeout.

## Out of scope

- Public project domains and generated-product hosting.
- Production data promotion.
- A full replacement token system beyond what this contract needs to finish the
  owner workspace.
- Arbitrary per-message model bypasses.
- Any provider secret committed to the repository.

## Milestones

0. M0: owner approval and operating model.
1. M1: design-source consolidation and dashboard navigation map.
2. M2: authenticated `dash.surachmancenter.com` access plan and rollback probe.
3. M3: shell/navigation polish.
4. M4: Telegram settings and test panel.
5. M5: conversation goal-clarification mode.
6. M6: project generation flow surface.
7. M7: runs, attempts, evidence, and model-cost surface.
8. M8: model policy and selection UI.
9. M9: Factory Live first real visualization pass.
10. M10: responsive, accessibility, loading, and error-state polish.
11. M11: live end-to-end dashboard drill.
12. M12: security review, README, resume checkpoint, deploy, and close.

## Gates

- DeepSeek-authored implementation is reviewed by Codex before merge.
- Every milestone has evidence before the next one starts.
- No milestone silently expands into multiple large surfaces.
- `npm run typecheck`, `npm run format:check`, backend tests with the documented
  zero-skip invocation, `npm run dashboard:test`, `npm run dashboard:build`,
  `node --import tsx scripts/verify-contract.ts CONTRACT-019`, and
  `node --import tsx scripts/resume-checkpoint.ts --check` pass before push.
- Authenticated dashboard access is verified live or explicitly marked blocked
  with the exact missing external condition.
- Telegram test messages and reports are bounded and non-spammy.
- Model selection UI shows policy and route reasoning rather than hidden
  provider choice.
- `/security-review` or an equivalent documented review pass runs before close.

## Acceptance

- The owner can use `https://dash.surachmancenter.com` with authentication to
  operate the factory.
- The owner can clarify goals, generate a project, inspect execution, approve
  work, see model/cost attribution, and observe Telegram state without leaving
  the dashboard.
- Telegram remains useful and quiet.
- Model selection is understandable, provider-neutral, and policy-safe.
- CONTRACT-018 M7 can be completed after this contract's live drill because the
  dashboard is finished enough to validate the chat experience in its real
  operating context.

## Rollback

Revert the contract commit and repoint services to the previous release. For
`dash.surachmancenter.com`, retain the pre-cutover route or restore the prior
service target documented in M2 evidence.

## File ownership

- `.gitignore`
- `README.md`
- `CLAUDE.md`
- `deploy/**`
- `docs/RESUME.md`
- `docs/contracts/CONTRACT-019/**`
- `docs/contracts/CONTRACT-018/**`
- `docs/design/**`
- `docs/operations/**`
- `docs/product/**`
- `docs/source-of-truth/**`
- `migrations/**`
- `package.json`
- `package-lock.json`
- `src/control-api/**`
- `src/dashboard/**`
- `src/factory/**`
- `src/gateway/**`
- `src/operations/**`
- `src/orchestrator/**`
- `src/policy/**`
- `src/telegram/**`
- `tests/**`
- `vite.config.ts`
