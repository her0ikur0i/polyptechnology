export type ProgrammingTaskClass =
  "bulk_code" | "complex_backend" | "bounded_repair";
export type TechnicalProvider = "deepseek" | "claude" | "codex";

// The single policyKey the live executor consults (src/operations/
// policy-route-resolver.ts) for all three programming task classes at
// once -- the dashboard's Policy page must draft/activate under this same
// key, otherwise an activated policy silently affects nothing real.
export const PROGRAMMING_POLICY_KEY = "programming-routes";

export interface ProgrammingRoute {
  provider: "deepseek" | "codex" | "claude";
  requestedModelId: string;
  priority: number;
}

export interface ExecutionEnvelope {
  softBudgetUsdMicros: number;
  emergencyCostCeilingUsdMicros: number;
  maxOutputTokens: number;
  maxTurns: number;
  timeoutMs: number;
  concurrency: number;
}

export interface RuntimePolicy {
  routesByTaskClass: Record<
    ProgrammingTaskClass,
    ReadonlyArray<ProgrammingRoute>
  >;
  envelope: ExecutionEnvelope;
}

export interface FailureEvidence {
  taskId: string;
  provider: "deepseek" | "codex";
  outcome: "failed";
  code: string;
  verified: true;
}

export interface OwnerOverride {
  taskId: string;
  ownerId: string;
  reason: string;
  expiresAt: Date;
  codexTechnicalExecution: true;
}

export interface SimulationResult {
  selected: ProgrammingRoute | null;
  readonly reasons: ReadonlyArray<string>;
}
