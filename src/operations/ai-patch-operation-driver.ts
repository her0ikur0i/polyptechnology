import type {
  OperationContext,
  OperationDriver,
} from "./execution-supervisor.js";
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
    // Which attempt this is. A tier that fails without recording a verdict
    // would otherwise be retried until the task runs out of attempts, so the
    // resolver needs to know how many have already been spent.
    attemptOrdinal?: number,
  ): Promise<StoredAiPatchTaskInput["route"]>;
  failureEvidence?(taskId: string): Promise<ReadonlyArray<string>>;
}

const staticFallbackResolver: RouteResolver = {
  async resolve(_taskClass, _taskId, fallback) {
    return fallback;
  },
};

// Called once a patch has been accepted, so a generated project's lifecycle
// can record that it now contains generated software. Optional: a patch task
// that is not a project generation simply does not supply one.
export type PatchAcceptedHook = (input: {
  projectId: string;
  taskId: string;
}) => Promise<void>;

export class AiPatchOperationDriver implements OperationDriver {
  constructor(
    private readonly inner: AiPatchExecutorDriver,
    private readonly routeResolver: RouteResolver = staticFallbackResolver,
    private readonly onAccepted?: PatchAcceptedHook,
  ) {}

  async execute(
    input: unknown,
    signal: AbortSignal,
    context?: OperationContext,
  ): Promise<unknown> {
    const stored = parseStoredAiPatchTaskInput(input);
    const attemptOrdinalForRoute = context?.attemptOrdinal ?? 1;
    const route = await this.routeResolver.resolve(
      stored.taskClass,
      stored.taskId,
      stored.route,
      attemptOrdinalForRoute,
    );
    // One ledger entry per attempt, exactly as ConversationReplyDriver does.
    //
    // The stored key lives in `operation_task_specs.input`, which is immutable
    // by trigger, so every one of a task's attempts presented the same key.
    // The gateway hashes the route into the request, so the two possible
    // outcomes were both fatal: an unchanged route matched the stored hash and
    // raised "attempt already exists", and an escalated route did not and
    // raised "idempotency intent mismatch". Either way the retry died before
    // reserving budget or reaching a provider.
    //
    // The consequence was that attempt 1 was the only attempt a generation
    // task could ever make, and `maxAttempts: 6` -- written to "walk deepseek
    // -> codex -> claude" -- could never walk anywhere. The escalation chain
    // this system is built around had never once run on a generation task.
    //
    // Attempt 1 keeps the original key so nothing already in the ledger is
    // orphaned, and a genuine duplicate delivery still deduplicates.
    const attemptOrdinal = context?.attemptOrdinal ?? 1;
    const idempotencyKey =
      attemptOrdinal <= 1
        ? stored.idempotencyKey
        : `${stored.idempotencyKey}#${attemptOrdinal}`;
    const failureEvidence =
      attemptOrdinal > 1 && this.routeResolver.failureEvidence !== undefined
        ? await this.routeResolver.failureEvidence(stored.taskId)
        : [];
    const messages =
      failureEvidence.length === 0
        ? stored.messages
        : [
            ...stored.messages,
            {
              role: "user" as const,
              content: [
                "Previous generated patches failed verification. Repair these",
                "exact failures in your new complete diff:",
                ...failureEvidence.map((reason) => `- ${reason}`),
              ].join("\n"),
            },
          ];
    const result = await this.inner.run({
      taskId: stored.taskId,
      gatewayRequest: {
        idempotencyKey,
        taskClass: stored.taskClass,
        attribution: stored.attribution,
        messages,
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

    // An accepted patch is the moment a generated project stops being a
    // scaffold and starts being software, so it is the moment its lifecycle
    // should say so. Nothing did: `ProjectLifecycle` defines
    // idea -> blueprint -> provisioned -> development, and no code anywhere
    // ever wrote the last two. A flawless generation left the project sitting
    // at `blueprint` forever, which meant the pipeline had no representation
    // of "finished" at all.
    //
    // Injected rather than imported, because this driver is the generic patch
    // executor -- a patch task that is not a generation supplies no hook and
    // behaves exactly as before.
    //
    // Failure here fails the task, deliberately. An accepted patch whose
    // project state cannot be recorded is not a completed generation, and this
    // system's rule is to fail closed rather than report a success it cannot
    // substantiate.
    if (result.status === "accepted")
      await this.onAccepted?.({
        projectId: stored.attribution.projectId,
        taskId: stored.taskId,
      });

    return {
      verified: result.status === "accepted",
      status: result.status,
      decisionAction: result.decision.action,
      touchedPaths: result.touchedPaths,
    };
  }
}
