import type { AttemptOutcome } from "../gateway/types.js";
import type { FailureEvidence } from "./types.js";

export type ProviderArtifactStatus = "accepted" | "rejected";

export interface AttemptOutcomeSignal {
  outcome: AttemptOutcome;
  failureCode?: string;
  artifactStatus?: ProviderArtifactStatus;
}

export type EscalationDecision =
  | { action: "none"; reason: string }
  | { action: "retry_same_tier"; reason: string }
  | { action: "escalate"; reason: string };

// Chain: deepseek -> codex -> claude. Transport/protocol failures (bad
// envelope, timeout, empty response, rejected accounting) never produced a
// real code artifact, so they must retry the *same* tier, never escalate to
// a more expensive provider. Only a genuine patch-verifier rejection
// (provider_artifacts.status='rejected', attempt outcome 'succeeded') is
// durable, verified evidence that the task itself failed -- that is the only
// thing allowed to unlock the next fallback tier. Without this split, an
// envelope/parsing hiccup masquerades as a verified task failure and burns
// budget on a pricier provider for work the cheaper tier could have finished
// on retry.
export function classifyAttempt(
  signal: AttemptOutcomeSignal,
): EscalationDecision {
  if (signal.outcome === "succeeded" && signal.artifactStatus === "accepted")
    return { action: "none", reason: "Attempt succeeded and patch accepted." };
  if (signal.outcome === "succeeded" && signal.artifactStatus === "rejected")
    return {
      action: "escalate",
      reason: "Verified patch rejection by isolated verifier.",
    };
  if (signal.outcome === "succeeded" && signal.artifactStatus === undefined)
    return {
      action: "retry_same_tier",
      reason: "Attempt succeeded but has not been verified yet.",
    };
  return {
    action: "retry_same_tier",
    reason: `Transport/protocol failure (${signal.failureCode ?? signal.outcome}), not a verified task failure.`,
  };
}

export function toFailureEvidence(
  taskId: string,
  provider: "deepseek" | "codex",
  decision: EscalationDecision,
  code: string,
): FailureEvidence | undefined {
  if (decision.action !== "escalate") return undefined;
  if (!code.trim()) return undefined;
  return { taskId, provider, outcome: "failed", code, verified: true };
}
