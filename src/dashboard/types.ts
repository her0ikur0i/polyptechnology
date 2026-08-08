export type Freshness = "fresh" | "stale" | "partial";
export type RunOutcome =
  "reserved" | "running" | "succeeded" | "failed" | "outcome_unknown";
export interface Observed<T> {
  data: T;
  observedAt: string;
  freshness: Freshness;
  source: string;
  issues: ReadonlyArray<string>;
}
export interface AttentionItem {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  sourceHref: string;
}
export interface ProjectSummary {
  id: string;
  name: string;
  lifecycle: string;
  attention: string;
  updatedAt: string;
}
export interface ContractSummary {
  id: string;
  title: string;
  milestone: string;
  state: string;
  gateStatus: string;
  publishedSha?: string;
}
export interface ModelAttempt {
  id: string;
  provider: "deepseek" | "codex" | "claude";
  requestedModelId: string;
  resolvedModelId?: string;
  resolutionSource?: "provider_response" | "pinned_request";
  role: string;
  outcome: RunOutcome;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: number;
  verified: boolean;
  artifactSha256?: string;
}
export interface ApprovalSummary {
  id: string;
  action: string;
  risk: string;
  state: string;
  expiresAt: string;
}
export interface TelegramSettings {
  secretRef?: string;
  authorizedChatIds: ReadonlyArray<string>;
  authorizedUserIds: ReadonlyArray<string>;
  configurationReady: boolean;
  lastCheckedAt?: string;
  liveProbeState: "not_run" | "passed" | "failed";
  approvalRequiredForProbe: boolean;
}
export interface TelegramSettingsCommand {
  secretRef: string;
  authorizedChatIds: ReadonlyArray<string>;
  authorizedUserIds: ReadonlyArray<string>;
}
export interface CommandPolicy {
  csrfToken: string;
  canConfigureTelegram: boolean;
}
export interface SequenceSummary {
  state: "running" | "owner_blocked" | "gate_failed" | "completed" | "stopped";
  contractId?: string;
  milestoneId?: string;
  heartbeatAt?: string;
  ownerBlockers: number;
}
export interface DashboardSnapshot {
  attention: Observed<ReadonlyArray<AttentionItem>>;
  projects: Observed<ReadonlyArray<ProjectSummary>>;
  contracts: Observed<ReadonlyArray<ContractSummary>>;
  attempts: Observed<ReadonlyArray<ModelAttempt>>;
  approvals: Observed<ReadonlyArray<ApprovalSummary>>;
  telegram: Observed<TelegramSettings>;
  sequence: Observed<SequenceSummary>;
  commandPolicy: CommandPolicy;
}
export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: T };
