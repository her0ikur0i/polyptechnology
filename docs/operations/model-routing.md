# Model routing operations

Routing starts by eliminating candidates that violate lifecycle, account, health,
capability, context/output limits, region policy, pricing coverage, or budget. It
then ranks eligible models according to the selected mode and records the chosen
model, rejected candidates, estimate, and bounded fallback chain.

Before dynamic activation, manual execution uses DeepSeek V4 Pro for bounded
bulk work and orchestration, DeepSeek V4 Flash as the same-provider fallback,
Claude `sonnet` for specialist review, Claude `opus` only as escalation, and
Codex for integration/final gates. Each attempt records both the
requested alias and provider-resolved model ID; aliases are not treated as stable
model versions.

Provider calls use health probes, bounded turns/tokens/timeouts, one reduced-scope
retry, then task-specific fallback. Authentication and policy failures never loop.
No estimate grants permission to exceed attempt/task/contract budgets.
