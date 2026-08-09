export type Lifecycle =
  | "discovered"
  | "configured"
  | "evaluation"
  | "canary"
  | "active"
  | "degraded"
  | "disabled"
  | "deprecated"
  | "retired";
export type RoutingMode =
  | "balanced"
  | "lowest_cost"
  | "highest_quality"
  | "fastest"
  | "manual"
  | "policy_locked";
export type Capability =
  "text" | "tools" | "vision" | "structured_output" | "reasoning";
export interface Provider {
  id: string;
  name: string;
  lifecycle: Lifecycle;
}
export interface Account {
  id: string;
  providerId: string;
  secretRef: string;
  region: string;
  lifecycle: Lifecycle;
}
export interface PriceVersion {
  effectiveFrom: Date;
  effectiveTo?: Date;
  inputUsdMicrosPerMillion: number;
  outputUsdMicrosPerMillion: number;
}
export interface Model {
  id: string;
  providerId: string;
  accountId: string;
  name: string;
  lifecycle: Lifecycle;
  capabilities: ReadonlySet<Capability>;
  contextLimit: number;
  outputLimit: number;
  health: "healthy" | "degraded" | "down" | "unknown";
  latencyMs: number;
  quality: number;
  reliability: number;
  prices: ReadonlyArray<PriceVersion>;
}
export interface RouteRequest {
  mode: RoutingMode;
  required: ReadonlySet<Capability>;
  inputTokens: number;
  outputTokens: number;
  maxCostUsdMicros: number;
  contextTokens: number;
  allowedRegions?: ReadonlySet<string>;
  manualModelId?: string;
  policyModelIds?: ReadonlySet<string>;
  maxFallbacks: number;
}
export interface Candidate {
  model: Model;
  estimatedCostUsdMicros: number;
  score: number;
}
export interface RouteDecision {
  outcome: "selected";
  selected: Candidate;
  fallbacks: ReadonlyArray<Candidate>;
  rejected: ReadonlyArray<{ modelId: string; reasons: ReadonlyArray<string> }>;
}
export interface RouteBlocked {
  outcome: "blocked";
  reason:
    | "no_eligible_model"
    | "budget_exceeded"
    | "manual_model_unavailable"
    | "policy_model_unavailable";
  rejected: ReadonlyArray<{ modelId: string; reasons: ReadonlyArray<string> }>;
}
export interface UsageAttribution {
  id: string;
  providerId: string;
  accountId: string;
  modelId: string;
  agentId: string;
  projectId: string;
  contractId: string;
  taskId: string;
  attemptId: string;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  occurredAt: Date;
}
export interface Evaluation {
  id: string;
  modelId: string;
  suite: string;
  quality: number;
  successRate: number;
  securityPass: boolean;
  occurredAt: Date;
  reviewerAgentId: string;
}
