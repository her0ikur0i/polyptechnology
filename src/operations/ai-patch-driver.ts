import { createHash } from "node:crypto";
import { executeWorker } from "../worker/executor.js";
import { validatePatchScope } from "./patch-scope.js";
import { classifyAttempt } from "../policy/failure-classification.js";
import type { EscalationDecision } from "../policy/failure-classification.js";
import type { AiGateway } from "../gateway/gateway.js";
import type { GatewayRequest, ModelRoute } from "../gateway/types.js";
import type { WorkerJob, WorkerRunner } from "../worker/types.js";
import type { ProviderArtifactInput } from "./provider-artifact-store.js";

export interface ProviderArtifactRecorder {
  record(input: ProviderArtifactInput): Promise<void>;
}

export interface WorkspaceCopier {
  // Copies the patched workspace (a real git repo) into a separate, clean
  // destination with no .git present -- executeWorker() refuses any
  // workspace that has one, so the git-apply target and the verification
  // sandbox can never be the same directory.
  copy(source: string, destination: string): Promise<void>;
}

export interface PatchApplier {
  // Applies a unified diff to an isolated workspace copy and returns the
  // number of changed lines. Implementations must never touch the real
  // repository directly -- workspaceRoot is expected to already be an
  // isolated worktree/copy the caller owns.
  apply(
    workspaceRoot: string,
    patch: string,
  ): Promise<{ changedLines: number }>;
}

export interface AiPatchTaskInput {
  taskId: string;
  gatewayRequest: Omit<GatewayRequest, "routeOverride">;
  route: ModelRoute;
  ownedPaths: ReadonlyArray<string>;
  workspaceRoot: string;
  verifyJob: WorkerJob;
  fallbackReason: string | null;
}

export interface AiPatchTaskResult {
  status: "accepted" | "rejected";
  decision: EscalationDecision;
  touchedPaths: ReadonlyArray<string>;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// The real M2 "DeepSeek patch executor": routes one attempt through
// AiGateway, validates the returned patch never touches a path outside the
// contract's ownership manifest, applies it to an isolated workspace, runs
// the verification command inside the existing hardened Docker sandbox
// (src/worker/executor.ts), and records the accept/reject verdict as an
// immutable provider_artifacts row -- the durable source
// derive-failure-evidence.ts later reads to unlock the next fallback tier.
export class AiPatchExecutorDriver {
  constructor(
    private readonly gateway: AiGateway,
    private readonly applier: PatchApplier,
    private readonly runner: WorkerRunner,
    private readonly artifacts: ProviderArtifactRecorder,
    private readonly workspaceCopier: WorkspaceCopier,
  ) {}

  async run(input: AiPatchTaskInput): Promise<AiPatchTaskResult> {
    const result = await this.gateway.execute({
      ...input.gatewayRequest,
      routeOverride: input.route,
    });

    let touchedPaths: ReadonlyArray<string>;
    try {
      touchedPaths = validatePatchScope(result.content, input.ownedPaths);
    } catch (error) {
      await this.recordRejection(
        input,
        result.attempt.id,
        result.attempt.resolvedModelId ?? input.route.requestedModelId,
        result.attempt.outputSha256 ?? sha256(result.content),
        error instanceof Error ? error.message : "patch scope violation",
      );
      const decision = classifyAttempt({
        outcome: "succeeded",
        artifactStatus: "rejected",
      });
      return { status: "rejected", decision, touchedPaths: [] };
    }

    const applied = await this.applier.apply(
      input.workspaceRoot,
      result.content,
    );
    await this.workspaceCopier.copy(
      input.workspaceRoot,
      input.verifyJob.workspaceRoot,
    );
    const verified = await executeWorker(input.verifyJob, this.runner);
    const status: "accepted" | "rejected" =
      verified.status === "succeeded" ? "accepted" : "rejected";

    await this.artifacts.record({
      attemptId: result.attempt.id,
      taskId: input.taskId,
      providerId: result.attempt.route.provider,
      requestedModelId: result.attempt.route.requestedModelId,
      resolvedModelId:
        result.attempt.resolvedModelId ?? input.route.requestedModelId,
      status,
      outputSha256: result.attempt.outputSha256 ?? sha256(result.content),
      patchSha256: status === "accepted" ? sha256(result.content) : null,
      changedLines: applied.changedLines,
      verifierId: status === "accepted" ? "isolated-worker-v1" : null,
      reason: status === "rejected" ? `verification_${verified.status}` : null,
      fallbackReason: input.fallbackReason,
    } satisfies ProviderArtifactInput);

    const decision = classifyAttempt({
      outcome: "succeeded",
      artifactStatus: status,
    });
    return { status, decision, touchedPaths };
  }

  private async recordRejection(
    input: AiPatchTaskInput,
    attemptId: string,
    resolvedModelId: string,
    outputSha256: string,
    reason: string,
  ): Promise<void> {
    await this.artifacts.record({
      attemptId,
      taskId: input.taskId,
      providerId: input.route.provider,
      requestedModelId: input.route.requestedModelId,
      resolvedModelId,
      status: "rejected",
      outputSha256,
      patchSha256: null,
      changedLines: 0,
      verifierId: null,
      reason,
      fallbackReason: input.fallbackReason,
    });
  }
}
