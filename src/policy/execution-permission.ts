import type {
  FailureEvidence,
  OwnerOverride,
  TechnicalProvider,
} from "./types.js";

export interface PermissionResult {
  allowed: boolean;
  reason: string;
}

function verifiedFailure(
  failures: readonly FailureEvidence[],
  taskId: string,
  provider: "deepseek" | "codex",
): boolean {
  return failures.some(
    (failure) =>
      failure.taskId === taskId &&
      failure.provider === provider &&
      failure.outcome === "failed" &&
      failure.verified === true &&
      failure.code.trim().length > 0,
  );
}

function validOwnerOverride(
  override: OwnerOverride | undefined,
  taskId: string,
  now: Date,
): boolean {
  return (
    override !== undefined &&
    override.taskId === taskId &&
    override.codexTechnicalExecution === true &&
    override.expiresAt instanceof Date &&
    override.expiresAt.getTime() > now.getTime() &&
    override.ownerId.trim().length > 0 &&
    override.reason.trim().length > 0
  );
}

// Chain: deepseek (primary) -> codex (fallback) -> claude (final fallback).
// Codex escalation is automatic on verified DeepSeek failure evidence (owner
// amendment to CONTRACT-011), with a manual owner override kept as an
// alternate path for cases outside the auto-escalation chain. Claude requires
// verified failure evidence for *both* deepseek and codex on the same task --
// it is the fallback of the fallback, never a shortcut past Codex.
export function technicalExecutionAllowed(
  provider: TechnicalProvider,
  taskId: string,
  now: Date,
  failures: readonly FailureEvidence[],
  override?: OwnerOverride,
): PermissionResult {
  if (provider === "deepseek")
    return {
      allowed: true,
      reason: "DeepSeek technical execution always allowed.",
    };
  if (provider === "codex") {
    if (verifiedFailure(failures, taskId, "deepseek"))
      return {
        allowed: true,
        reason: "Verified DeepSeek failure evidence present.",
      };
    if (validOwnerOverride(override, taskId, now))
      return { allowed: true, reason: "Valid codex owner override provided." };
    return {
      allowed: false,
      reason: "No verified DeepSeek failure or owner override for this task.",
    };
  }
  const hasVerifiedChain =
    verifiedFailure(failures, taskId, "deepseek") &&
    verifiedFailure(failures, taskId, "codex");
  return hasVerifiedChain
    ? {
        allowed: true,
        reason: "Verified DeepSeek and Codex failure evidence present.",
      }
    : {
        allowed: false,
        reason: "No verified DeepSeek+Codex failure chain for this task.",
      };
}
