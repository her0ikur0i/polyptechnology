import type { ModelRoute, TaskClass } from "./types.js";
export const MODEL_POLICY_VERSION = "2026-08-08.1";
const routes: Record<TaskClass, ReadonlyArray<ModelRoute>> = {
  bulk_code: [
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      role: "bulk-coder",
      mode: "non-thinking",
    },
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      role: "bulk-coder",
      mode: "thinking",
    },
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      role: "bulk-coder",
      mode: "thinking",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "hard-fallback",
      effort: "high",
    },
  ],
  complex_backend: [
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      role: "backend-coder",
      mode: "thinking",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "integrator",
      effort: "high",
    },
  ],
  bounded_repair: [
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-terra",
      role: "repair",
      effort: "medium",
    },
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "repair-fallback",
      effort: "high",
    },
  ],
  orchestration: [
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "orchestrator",
      effort: "high",
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
