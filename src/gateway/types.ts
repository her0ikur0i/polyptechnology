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
  // Resume a provider-side session instead of replaying the transcript.
  //
  // Optional at every layer on purpose: an adapter that does not support
  // sessions ignores it, and a caller with no stored session simply omits it
  // and sends the full history — which is what every call did before
  // CONTRACT-017A. The degraded path is the old path.
  resumeSessionId?: string;
  // Called with each incremental fragment of the answer as the provider emits
  // it, when the selected adapter supports streaming. Purely a
  // perceived-latency optimization: `content` on the returned completion stays
  // the single source of truth, so an adapter that cannot stream simply never
  // calls this, and a stream that dies mid-answer leaves no half-written
  // record anywhere. Never treat accumulated deltas as the answer.
  onDelta?: (fragment: string) => void;
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
    resumeSessionId?: string,
  ): Promise<ManagedCompletion>;
  // Optional. Same contract as invoke() -- same validation, same
  // ManagedCompletion, same failure semantics -- except that fragments of the
  // answer are handed to onDelta as they arrive. An adapter without it is not
  // broken and is never wrapped in a fake: the gateway falls back to invoke()
  // and the caller simply sees no deltas, which is honest about the provider
  // genuinely not streaming.
  invokeStreaming?(
    route: ModelRoute,
    messages: GatewayRequest["messages"],
    maxOutputTokens: number,
    onDelta: (fragment: string) => void,
    signal?: AbortSignal,
    resumeSessionId?: string,
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
// The failure code a reclaimed attempt carries. Named once and shared, so the
// ledger, the supervisor's log line and the tests cannot drift into three
// spellings of the same event -- which is how four dead string comparisons got
// into the gateway's catch block and stayed there.
export const STRANDED_ATTEMPT_CODE = "attempt_stranded_no_verdict";
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
  // Settle attempts that were dispatched and never came back, returning the
  // ids settled.
  //
  // Every other transition here happens in the process that owns the attempt.
  // That is exactly why this one is needed: if the process dies between
  // `dispatched()` and its verdict, nothing in the system was ever going to
  // finish the row. Twenty attempts sat in `dispatched` on staging for that
  // reason, holding $10.00 in reservations, and each one also denied the
  // escalation chain the evidence it reads to move to the next tier.
  //
  // The work engine already had this shape -- `reclaimExpired()` in
  // src/work/postgres-repository.ts reclaims leases whose holder vanished. The
  // ledger had no equivalent, so a crash was durable in the ledger and
  // recoverable everywhere else.
  //
  // `outcome_unknown` is the honest verdict, not a convenient one: a killed
  // process cannot say whether the provider ran, answered, or billed. That
  // keeps the reservation held, which is the existing meaning of unknown, and
  // leaves releasing the money to `reconcileUnknownAsFailed()` with real
  // evidence.
  reclaimStranded(olderThanMs: number): Promise<ReadonlyArray<string>>;
}
