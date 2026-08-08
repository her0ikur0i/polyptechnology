import type { FailureEvidence } from "./types.js";

export interface ProviderArtifactRecord {
  taskId: string;
  providerId: string;
  status: "accepted" | "rejected";
  reason: string | null;
}

// The durable source of "did this provider genuinely fail this task" is
// provider_artifacts, not a separate evidence table -- a 'rejected' row *is*
// the verified failure (see src/policy/failure-classification.ts for how it
// got there: only an isolated-verifier rejection reaches this state, never a
// transport/protocol hiccup). This turns that durable record into the
// FailureEvidence[] shape execution-permission.ts / simulate-route.ts read.
export function deriveFailureEvidence(
  records: ReadonlyArray<ProviderArtifactRecord>,
): FailureEvidence[] {
  const evidence: FailureEvidence[] = [];
  for (const record of records) {
    if (record.status !== "rejected") continue;
    if (record.providerId !== "deepseek" && record.providerId !== "codex")
      continue;
    evidence.push({
      taskId: record.taskId,
      provider: record.providerId,
      outcome: "failed",
      code: record.reason?.trim() || "verified_patch_rejection",
      verified: true,
    });
  }
  return evidence;
}
