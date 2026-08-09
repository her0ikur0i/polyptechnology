import type { OperationDriver } from "./execution-supervisor.js";
import { AiPatchExecutorDriver } from "./ai-patch-driver.js";
import type { AiPatchTaskInput } from "./ai-patch-driver.js";
import type {
  GatewayAttribution,
  ModelRoute,
  TaskClass,
} from "../gateway/types.js";
import type { WorkerCapability, WorkerJob } from "../worker/types.js";

// operation_task_specs.input is jsonb -- it cannot carry a ReadonlySet or an
// AbortSignal, so the durable, stored shape differs slightly from
// AiPatchTaskInput (capabilities as a plain string array; no signal field).
// This is the boundary that reconstructs the real typed input the driver
// needs, failing closed on anything malformed rather than guessing.
export interface StoredAiPatchTaskInput {
  taskId: string;
  taskClass: TaskClass;
  idempotencyKey: string;
  attribution: GatewayAttribution;
  messages: ReadonlyArray<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  maxOutputTokens: number;
  maxCostUsdMicros: number;
  policyVersion: string;
  route: ModelRoute;
  ownedPaths: ReadonlyArray<string> | "unscoped";
  workspaceRoot: string;
  verifyJob: {
    isolationRoot: string;
    workspaceRoot: string;
    image: string;
    command: string;
    args: ReadonlyArray<string>;
    ownedPaths: ReadonlyArray<string>;
    capabilities: ReadonlyArray<WorkerCapability>;
    timeoutMs: number;
    outputByteLimit: number;
    memoryMb: number;
    cpuLimit: number;
    environment: Readonly<Record<string, string>>;
  };
  fallbackReason: string | null;
}

const validCapabilities = new Set<WorkerCapability>([
  "process",
  "network",
  "secrets",
]);

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(
      `ai_patch_executor input: ${label} must be a nonblank string`,
    );
  return value;
}

export function parseStoredAiPatchTaskInput(
  raw: unknown,
): StoredAiPatchTaskInput {
  if (typeof raw !== "object" || raw === null)
    throw new Error("ai_patch_executor input must be an object");
  const input = raw as Record<string, unknown>;
  const verifyJobRaw = input.verifyJob as Record<string, unknown> | undefined;
  if (typeof verifyJobRaw !== "object" || verifyJobRaw === null)
    throw new Error("ai_patch_executor input: verifyJob must be an object");
  const capabilitiesRaw = verifyJobRaw.capabilities;
  if (
    !Array.isArray(capabilitiesRaw) ||
    capabilitiesRaw.some((c) => !validCapabilities.has(c as WorkerCapability))
  )
    throw new Error("ai_patch_executor input: verifyJob.capabilities invalid");
  return {
    taskId: assertString(input.taskId, "taskId"),
    taskClass: assertString(input.taskClass, "taskClass") as TaskClass,
    idempotencyKey: assertString(input.idempotencyKey, "idempotencyKey"),
    attribution: input.attribution as GatewayAttribution,
    messages: input.messages as StoredAiPatchTaskInput["messages"],
    maxOutputTokens: input.maxOutputTokens as number,
    maxCostUsdMicros: input.maxCostUsdMicros as number,
    policyVersion: assertString(input.policyVersion, "policyVersion"),
    route: input.route as ModelRoute,
    ownedPaths:
      input.ownedPaths === "unscoped"
        ? "unscoped"
        : (input.ownedPaths as ReadonlyArray<string>),
    workspaceRoot: assertString(input.workspaceRoot, "workspaceRoot"),
    verifyJob: {
      isolationRoot: assertString(
        verifyJobRaw.isolationRoot,
        "verifyJob.isolationRoot",
      ),
      workspaceRoot: assertString(
        verifyJobRaw.workspaceRoot,
        "verifyJob.workspaceRoot",
      ),
      image: assertString(verifyJobRaw.image, "verifyJob.image"),
      command: assertString(verifyJobRaw.command, "verifyJob.command"),
      args: verifyJobRaw.args as ReadonlyArray<string>,
      ownedPaths: verifyJobRaw.ownedPaths as ReadonlyArray<string>,
      capabilities: capabilitiesRaw as ReadonlyArray<WorkerCapability>,
      timeoutMs: verifyJobRaw.timeoutMs as number,
      outputByteLimit: verifyJobRaw.outputByteLimit as number,
      memoryMb: verifyJobRaw.memoryMb as number,
      cpuLimit: verifyJobRaw.cpuLimit as number,
      environment:
        (verifyJobRaw.environment as Readonly<Record<string, string>>) ?? {},
    },
    fallbackReason: (input.fallbackReason as string | null) ?? null,
  };
}

function toWorkerJob(stored: StoredAiPatchTaskInput["verifyJob"]): WorkerJob {
  return { ...stored, capabilities: new Set(stored.capabilities) };
}

// Adapts AiPatchExecutorDriver (typed, DI-friendly) to the OperationDriver
// interface ExecutableTaskSupervisor drives (execute(input: unknown, signal)
// -> Promise<unknown>). The returned { verified } boolean is the self-
// verification signal execution-supervisor.ts checks in place of a
// precomputed output hash (operation_task_specs.expected_output_sha256 is
// NULL for this driver -- see migrations/0009_ai_patch_executor.sql).
export interface RouteResolver {
  resolve(
    taskClass: StoredAiPatchTaskInput["taskClass"],
    taskId: string,
    fallback: StoredAiPatchTaskInput["route"],
  ): Promise<StoredAiPatchTaskInput["route"]>;
}

const staticFallbackResolver: RouteResolver = {
  async resolve(_taskClass, _taskId, fallback) {
    return fallback;
  },
};

export class AiPatchOperationDriver implements OperationDriver {
  constructor(
    private readonly inner: AiPatchExecutorDriver,
    private readonly routeResolver: RouteResolver = staticFallbackResolver,
  ) {}

  async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
    const stored = parseStoredAiPatchTaskInput(input);
    const route = await this.routeResolver.resolve(
      stored.taskClass,
      stored.taskId,
      stored.route,
    );
    const result = await this.inner.run({
      taskId: stored.taskId,
      gatewayRequest: {
        idempotencyKey: stored.idempotencyKey,
        taskClass: stored.taskClass,
        attribution: stored.attribution,
        messages: stored.messages,
        maxOutputTokens: stored.maxOutputTokens,
        maxCostUsdMicros: stored.maxCostUsdMicros,
        policyVersion: stored.policyVersion,
        signal,
      },
      route,
      ownedPaths: stored.ownedPaths,
      workspaceRoot: stored.workspaceRoot,
      verifyJob: toWorkerJob(stored.verifyJob),
      fallbackReason: stored.fallbackReason,
    } satisfies AiPatchTaskInput);
    return {
      verified: result.status === "accepted",
      status: result.status,
      decisionAction: result.decision.action,
      touchedPaths: result.touchedPaths,
    };
  }
}
