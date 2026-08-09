export type TaskState =
  | "draft"
  | "queued"
  | "leased"
  | "running"
  | "verifying"
  | "retry_wait"
  | "needs_approval"
  | "budget_blocked"
  | "succeeded"
  | "failed"
  | "cancelled";
export type FailureReason =
  | "rate_limit"
  | "timeout"
  | "invalid_output"
  | "verification"
  | "authentication"
  | "provider_outage"
  | "budget"
  | "policy"
  | "worker";
export interface Task {
  id: string;
  contractId: string;
  milestoneId: string;
  idempotencyKey: string;
  state: TaskState;
  maxCostUsdMicros: number;
  spentUsdMicros: number;
  attemptCount: number;
  maxAttempts: number;
}
export interface Lease {
  taskId: string;
  workerId: string;
  fencingToken: number;
  attemptOrdinal: number;
  expiresAt: Date;
  heartbeatAt: Date;
}
export interface Gate {
  id: string;
  passed: boolean;
  evidenceIds: ReadonlyArray<string>;
}
export interface ContractPublication {
  contractId: string;
  baselineSha: string;
  ownedPaths: ReadonlyArray<string>;
  gates: ReadonlyArray<Gate>;
  preparing?: boolean;
  preparedSha?: string;
  publishedSha?: string;
}
