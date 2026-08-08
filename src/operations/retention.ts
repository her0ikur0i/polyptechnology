export interface RetentionPolicy {
  domain:
    | "audit"
    | "events"
    | "logs"
    | "artifacts"
    | "conversations"
    | "knowledge"
    | "projects";
  retainDays: number;
  archiveBeforeDelete: boolean;
  approvalRequired: boolean;
  derivedPurgeRequired: boolean;
  policyVersion: number;
}
export function validateRetentionPolicy(policy: RetentionPolicy) {
  if (
    !Number.isSafeInteger(policy.retainDays) ||
    policy.retainDays < 1 ||
    policy.retainDays > 3650 ||
    !Number.isSafeInteger(policy.policyVersion) ||
    policy.policyVersion < 1
  )
    throw new Error("invalid retention policy");
  if (
    ["knowledge", "projects"].includes(policy.domain) &&
    (!policy.approvalRequired || !policy.derivedPurgeRequired)
  )
    throw new Error("unsafe retention policy");
  if (
    ["audit", "projects"].includes(policy.domain) &&
    !policy.archiveBeforeDelete
  )
    throw new Error("archive required");
  return structuredClone(policy);
}
