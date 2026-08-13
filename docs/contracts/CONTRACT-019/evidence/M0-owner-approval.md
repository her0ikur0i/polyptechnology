# M0 — Owner Approval and Operating Model

Date: 2026-08-13. Status: done.

The owner approved opening the frontend completion contract after CONTRACT-018
M6 and the Telegram report hotfix. The instruction is to proceed with DeepSeek
as the main implementation worker because Codex usage is constrained.

## Approved Operating Model

- DeepSeek is the main worker for frontend implementation.
- Codex is strategic coordinator, reviewer, verifier, integrator, and final
  gatekeeper.
- Milestones must be small and bounded so DeepSeek does not receive one large
  error-prone task.
- Codex usage should be conserved for contract control, reviews, tests, and
  final decisions.

## Approved Access Target

The owner wants the dashboard available at:

`https://dash.surachmancenter.com`

with authentication.

This M0 authorizes work on that hostname for the Master Dashboard, including
authentication setup, service routing, staging redeploy, and rollback proof.
The authorization is scoped to this hostname. It does not authorize unrelated
DNS changes, generated-project public domains, production data promotion, or
secret disclosure.

## Approved Design Sources

The owner asked to use the two prior references and local notes/mockups:

- `https://polyp-ui-review.heroikuroi.chatgpt.site/#deployment`
- `https://claude.ai/code/artifact/386ec810-0571-44ea-9fe8-68c47a880ac9`
- `docs/contracts/CONTRACT-018/evidence/M0-owner-confirmation.md`
- `docs/contracts/CONTRACT-018/review/deepseek-refero-ui-domain.html`
- `docs/contracts/CONTRACT-018/review/deepseek-ui-extreme.html`
- `docs/contracts/CONTRACT-018/review/ledger-ui.html`
- `docs/design/DESIGN.md`

The Claude artifact URL is recorded as an owner reference. If it is
authentication-gated for agents, the retained local notes and review artifacts
are the usable source of truth.

## Approved Telegram Standard

The owner explicitly asked for Telegram rules covering enriched but non-spammy
reports and settings for connecting/testing Telegram.

Accepted standard:

- terminal meaningful events only;
- human-readable title, subject, and summary;
- no raw UUIDs as the main label;
- bounded detail and safe escaping;
- model/cost/budget/attempt enrichment only when useful;
- Telegram delivery failure never breaks factory work;
- dashboard settings include connection data and a test path.

## Approved Model Selection Direction

The owner asked how to manage model choice when a conversation needs a strong
model for clarifying goals.

Accepted direction:

- expose policy-governed modes, not unsafe arbitrary bypasses;
- include a `Clarify goals` mode;
- prefer strong DeepSeek first for clarification;
- show route reason, provider/model, cost, and fallback chain;
- preserve budget, approval, and verified-failure gates.

## Next

M1 consolidates the design sources into a concrete navigation and page map for
DeepSeek implementation tasks.
