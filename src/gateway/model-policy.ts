import type { ModelRoute, TaskClass } from "./types.js";
export const MODEL_POLICY_VERSION = "2026-08-09.1";
// Owner-authorized role exchange (2026-08-09): Claude is strategic
// orchestrator; Codex retains integrator/verifier/final-gate duties and is
// now also the automatic technical-fallback tier (see
// docs/contracts/CONTRACT-011/contract.md amendment). Programming task
// classes escalate deepseek -> codex -> claude, cheapest viable tier first;
// escalation past deepseek requires verified failure evidence
// (src/policy/execution-permission.ts), never a bare retry count.
const routes: Record<TaskClass, ReadonlyArray<ModelRoute>> = {
  bulk_code: [
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      role: "primary-executor",
      mode: "non-thinking",
    },
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      role: "primary-executor-retry",
      mode: "thinking",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-terra",
      role: "technical-fallback",
      effort: "medium",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "technical-fallback-retry",
      effort: "high",
    },
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "technical-fallback-final",
      effort: "high",
    },
  ],
  complex_backend: [
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      role: "primary-executor",
      mode: "thinking",
    },
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      role: "primary-executor-retry",
      mode: "non-thinking",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-terra",
      role: "technical-fallback",
      effort: "medium",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "technical-fallback-retry",
      effort: "high",
    },
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "technical-fallback-final",
      effort: "high",
    },
  ],
  bounded_repair: [
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      role: "primary-executor",
      mode: "non-thinking",
    },
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      role: "primary-executor-retry",
      mode: "thinking",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-terra",
      role: "technical-fallback",
      effort: "medium",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "technical-fallback-retry",
      effort: "high",
    },
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "technical-fallback-final",
      effort: "high",
    },
  ],
  orchestration: [
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "orchestrator",
      // Lowered from "high" on 2026-08-10: conversation is read on a phone and
      // ten seconds for a simple question is too slow. High effort buys careful
      // reasoning that a chat turn rarely needs, and the escalation tier is
      // still there for when it does.
      effort: "medium",
    },
    {
      provider: "claude",
      requestedModelId: "claude-opus-5",
      role: "orchestrator-escalation",
      effort: "xhigh",
    },
  ],
  light_review: [
    {
      provider: "claude",
      requestedModelId: "claude-haiku-4-5-20251001",
      role: "reviewer",
      effort: "medium",
    },
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "reviewer-fallback",
      effort: "high",
    },
  ],
  specialist_review: [
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "specialist-reviewer",
      effort: "high",
    },
    {
      provider: "claude",
      requestedModelId: "claude-opus-4-8",
      role: "review-escalation",
      effort: "xhigh",
    },
  ],
  critical_review: [
    {
      provider: "claude",
      requestedModelId: "claude-opus-4-8",
      role: "adversarial-reviewer",
      effort: "xhigh",
    },
    {
      provider: "claude",
      requestedModelId: "claude-opus-5",
      role: "exceptional-escalation",
      effort: "high",
    },
    {
      // Non-Claude escalation so critical_review is never a Claude single
      // point of failure (docs/SYSTEM-SPECIFICATION.md #3). Callers must also
      // enforce that this route is never selected for a task Codex itself
      // executed as a technical-fallback tier (anti self-review).
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "hard-fallback-reviewer",
      effort: "high",
    },
  ],
  independent_review: [
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "independent-reviewer",
      effort: "high",
    },
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      role: "independent-review-fallback",
      mode: "non-thinking",
    },
  ],
};
export function modelRoutes(taskClass: TaskClass): ReadonlyArray<ModelRoute> {
  return routes[taskClass].map((route) => ({ ...route }));
}
