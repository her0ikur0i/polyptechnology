export type ManagedProvider = "deepseek" | "codex" | "claude";
export type TaskClass =
  | "bulk_code"
  | "complex_backend"
  | "bounded_repair"
  | "orchestration"
  | "light_review"
  | "specialist_review"
  | "critical_review"
  | "independent_review";
export type AttemptOutcome =
  "reserved" | "dispatched" | "succeeded" | "failed" | "outcome_unknown";
export interface ModelRoute {
  provider: ManagedProvider;
  requestedModelId: string;
  role: string;
  mode?: "thinking" | "non-thinking";
  effort?: "low" | "medium" | "high" | "xhigh";
}
export interface GatewayAttribution {
  projectId: string;
  contractId: string;
  milestoneId: string;
  taskId: string;
  taskAttemptOrdinal: number;
  agentId: string;
}
export interface GatewayRequest {
  idempotencyKey: string;
  taskClass: TaskClass;
  attribution: GatewayAttribution;
  messages: ReadonlyArray<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  maxOutputTokens: number;
  maxCostUsdMicros: number;
  policyVersion: string;
  routeOverride?: ModelRoute;
  signal?: AbortSignal;
}
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: number;
}
export interface ModelUsageSlice extends NormalizedUsage {
  resolvedModelId: string;
}
export interface ManagedCompletion {
  providerRequestId: string;
  resolvedModelId: string;
  resolutionSource: "provider_response" | "pinned_request";
  content: string;
  usage: NormalizedUsage;
  modelUsage: ReadonlyArray<ModelUsageSlice>;
  rawModelId?: string;
}
export interface GatewayAttempt {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  outcome: AttemptOutcome;
  route: ModelRoute;
  attribution: GatewayAttribution;
  policyVersion: string;
  reservedCostUsdMicros: number;
  providerRequestId?: string;
  resolvedModelId?: string;
  resolutionSource?: "provider_response" | "pinned_request";
  usage?: NormalizedUsage;
  outputSha256?: string;
  failureCode?: string;
  createdAt: Date;
  finalizedAt?: Date;
}
export interface GatewayResult {
  attempt: GatewayAttempt;
  content: string;
}
export interface AttemptVerification {
  attemptId: string;
  passed: boolean;
  verifier: string;
  evidenceSha256: string;
  verifiedAt: Date;
}
export interface ManagedProviderAdapter {
  readonly provider: ManagedProvider;
  listModels(): Promise<ReadonlyArray<string>>;
  invoke(
    route: ModelRoute,
    messages: GatewayRequest["messages"],
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<ManagedCompletion>;
}
export class ManagedInvocationError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
    readonly providerRequestId?: string,
  ) {
    super(code);
  }
}
export interface AttemptLedger {
  reserve(
    attempt: GatewayAttempt,
  ): Promise<{ attempt: GatewayAttempt; created: boolean }>;
  dispatched(attemptId: string): Promise<void>;
  succeed(
    attemptId: string,
    result: ManagedCompletion,
    outputSha256: string,
  ): Promise<GatewayAttempt>;
  reject(
    attemptId: string,
    result: ManagedCompletion,
    code: string,
  ): Promise<GatewayAttempt>;
  fail(
    attemptId: string,
    code: string,
    outcomeUnknown: boolean,
    providerRequestId?: string,
  ): Promise<GatewayAttempt>;
  getByIdempotency(key: string): Promise<GatewayAttempt | undefined>;
}
