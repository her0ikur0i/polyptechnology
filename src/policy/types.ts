export type ProgrammingTaskClass =
  "bulk_code" | "complex_backend" | "bounded_repair";
export type TechnicalProvider = "deepseek" | "claude" | "codex";

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
