import { createHash } from "node:crypto";
import { executeWorker } from "../worker/executor.js";
import { extractUnifiedDiff, validatePatchScope } from "./patch-scope.js";
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

// Runs the generated project's own formatter over its workspace.
//
// Verification is `typecheck && format:check && test` in a read-only sandbox,
// so a patch that is correct but formatted differently is rejected exactly
// like a failing test. Real evidence, once patches finally started applying:
// every tier produced code that **passed `tsc --noEmit`** and was rejected on
// `prettier --check src/index.ts`.
//
// Demanding that a model reproduce Prettier's output byte-for-byte is asking
// it to be a formatter. Running the formatter is deterministic, is what a
// human does, and leaves the gate intact -- `format:check` still runs in the
// sandbox and still fails if the result is not formatted, so the accepted
// artifact is provably clean. What changes is that "clean" is achieved rather
// than guessed.
//
// This adjusts the reasoning in verification-image-policy.ts, which argued the
// rejection was the point. That held while nothing had ever reached the gate;
// with real evidence it only rejected correct work.
export interface WorkspaceFormatter {
  format(workspaceRoot: string): Promise<void>;
}

export interface PatchApplier {
  // Applies a unified diff to a workspace the caller owns and returns the
  // number of changed lines.
  apply(
    workspaceRoot: string,
    patch: string,
  ): Promise<{ changedLines: number }>;
  // Returns the workspace to its last committed state, discarding whatever
  // apply() wrote. Called when a patch is rejected, so a failed attempt does
  // not become the baseline the next attempt patches on top of.
  revert(workspaceRoot: string): Promise<void>;
  // Records an accepted patch as a commit and returns its sha.
  //
  // Without this an accepted patch sat in the working tree forever: the
  // project had generated code and a git history containing only "Initial
  // scaffold", so nothing durable said what the factory built, `revert()` on a
  // later attempt would have destroyed it, and a second generation would have
  // patched against a baseline git did not agree with.
  commit(workspaceRoot: string, message: string): Promise<string>;
}

export interface AiPatchTaskInput {
  taskId: string;
  gatewayRequest: Omit<GatewayRequest, "routeOverride">;
  route: ModelRoute;
  ownedPaths: ReadonlyArray<string> | "unscoped";
  workspaceRoot: string;
  verifyJob: WorkerJob;
  fallbackReason: string | null;
}

export interface AiPatchTaskResult {
  status: "accepted" | "rejected";
  decision: EscalationDecision;
  touchedPaths: ReadonlyArray<string>;
  // Present only when a patch was accepted and committed.
  commitSha?: string;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// How much of the verification output is kept on the rejection record.
const VERIFICATION_TAIL_BYTES = 1_200;

function deepSeekPatchContract(reason: string | null): string {
  return [
    "DEEPSEEK PATCH OUTPUT CONTRACT",
    "",
    "Your answer will be consumed directly by an automated git patch applier.",
    "Return only a unified git diff. The first non-whitespace bytes of your",
    "answer must be exactly `diff --git `.",
    "",
    "Do not include markdown fences, explanations, analysis, summaries, file",
    "trees, full-file dumps, or natural-language prefaces. Do not say you",
    "cannot apply the patch. Emit the patch itself.",
    "",
    "Allowed output shape:",
    "diff --git a/path b/path",
    "--- a/path",
    "+++ b/path",
    "@@ ... @@",
    "-old",
    "+new",
    "",
    ...(reason === null
      ? []
      : [
          "The previous attempt was rejected by the verifier. Produce a new",
          "complete replacement diff that directly fixes this reason:",
          reason,
          "",
          "Do not explain the fix. Return only the corrected diff.",
        ]),
  ].join("\n");
}

function patchMessagesForRoute(
  messages: GatewayRequest["messages"],
  route: ModelRoute,
  fallbackReason: string | null,
): GatewayRequest["messages"] {
  if (route.provider !== "deepseek") return messages;
  return [
    ...messages,
    {
      role: "user",
      content: deepSeekPatchContract(fallbackReason),
    },
  ];
}

// Why a patch was rejected, in the verifier's own words.
//
// `verification_failed` used to be recorded with nothing else, so a rejected
// patch was indistinguishable from a broken gate: nobody could tell whether
// the model wrote code that fails `typecheck` or whether the sandbox itself
// was misconfigured. The output existed the whole time -- executeWorker()
// returns it -- and this driver threw it away.
//
// That mattered more than it looks. The scaffold shipped for months unable to
// pass its own gates, and the symptom would have been exactly this: every
// patch rejected, no reason recorded, and the blame landing on the models.
//
// The tail rather than the head: `npm run typecheck && format:check && test`
// prints the failure last, and a head-capped buffer keeps the banner and drops
// the error -- the same mistake this repository already fixed once in the CLI
// stream runner's stderr handling.
function verificationTail(result: {
  process: { stdout: Buffer; stderr: Buffer; exitCode: number | null };
}): string {
  const merged = `${result.process.stdout.toString("utf8")}\n${result.process.stderr.toString("utf8")}`;
  const tail = merged.trim().slice(-VERIFICATION_TAIL_BYTES);
  return tail.length === 0
    ? `no output, exit ${result.process.exitCode ?? "unknown"}`
    : tail;
}

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
    // Optional: a patch task with no formatter behaves exactly as before.
    private readonly formatter?: WorkspaceFormatter,
  ) {}

  async run(input: AiPatchTaskInput): Promise<AiPatchTaskResult> {
    const result = await this.gateway.execute({
      ...input.gatewayRequest,
      messages: patchMessagesForRoute(
        input.gatewayRequest.messages,
        input.route,
        input.fallbackReason,
      ),
      routeOverride: input.route,
      // Streaming exists to keep long thinking calls alive. Programming
      // DeepSeek routes are deliberately non-thinking now: the observed heavy
      // failure was 90k-118k reasoning characters and zero patch content. Use
      // the buffered completion path so patch generation behaves like Codex
      // and Claude: one final answer, then the same verifier.
      ...(input.route.provider === "deepseek" &&
      input.route.mode === "thinking"
        ? { onDelta: () => {} }
        : {}),
    });

    // Providers present a diff differently -- bare, fenced, or after a
    // sentence of explanation. Normalise before validating, so a tier is
    // judged on the patch it produced rather than on how it wrapped it.
    const patch = extractUnifiedDiff(result.content);

    let touchedPaths: ReadonlyArray<string>;
    try {
      touchedPaths = validatePatchScope(patch, input.ownedPaths);
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

    // A patch that will not apply is a rejected patch, not a crashed task.
    //
    // `git apply` throwing used to propagate straight out of this driver, so
    // the attempt failed with **no `provider_artifacts` row written at all**.
    // That is the evidence `deriveFailureEvidence()` reads to unlock the next
    // fallback tier, so the most common failure a code executor has -- a diff
    // that does not apply -- was precisely the one that left no trace and could
    // never justify an escalation. Six real attempts against DeepSeek produced
    // six apply failures and zero artifacts before this was fixed.
    let applied: { changedLines: number };
    try {
      applied = await this.applier.apply(input.workspaceRoot, patch);
    } catch (error) {
      // Nothing was applied, so there is nothing to revert -- `git apply` is
      // all-or-nothing, and `--check` runs first.
      await this.recordRejection(
        input,
        result.attempt.id,
        result.attempt.resolvedModelId ?? input.route.requestedModelId,
        result.attempt.outputSha256 ?? sha256(result.content),
        error instanceof Error
          ? `patch_apply_failed: ${error.message}`
          : "patch_apply_failed",
      );
      const decision = classifyAttempt({
        outcome: "succeeded",
        artifactStatus: "rejected",
      });
      return { status: "rejected", decision, touchedPaths: [] };
    }
    // Format before verifying, not after: the sandbox is read-only by design,
    // so this is the only place the result can be made clean. A formatter
    // failure is not fatal -- verification will fail the patch on
    // `format:check` anyway, which is the honest outcome, and swallowing the
    // error here would hide why.
    if (this.formatter !== undefined) {
      try {
        await this.formatter.format(input.workspaceRoot);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "patch.format_failed",
            detail: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }

    await this.workspaceCopier.copy(
      input.workspaceRoot,
      input.verifyJob.workspaceRoot,
    );
    const verified = await executeWorker(input.verifyJob, this.runner);
    const status: "accepted" | "rejected" =
      verified.status === "succeeded" ? "accepted" : "rejected";

    // A rejected patch must not survive in the workspace.
    //
    // The patch is applied to the project's real repository, then copied
    // elsewhere to be verified. Without this, a rejected patch stayed applied,
    // and the next attempt -- a different provider, escalated to precisely
    // because the first one failed -- would build its diff against a tree
    // already carrying the failure it was called in to replace. `git apply`
    // would then fail on context, turning a recoverable rejection into a stuck
    // task, and the escalation chain would look broken when the real cause was
    // a dirty baseline.
    //
    // Reverting is not conditional on why verification failed: any outcome
    // other than acceptance leaves nothing worth keeping.
    if (status === "rejected") await this.applier.revert(input.workspaceRoot);

    // An accepted patch becomes a commit, so the generated project has a real
    // history rather than an indefinitely dirty working tree.
    let commitSha: string | undefined;
    if (status === "accepted")
      commitSha = await this.applier.commit(
        input.workspaceRoot,
        `Generated by ${result.attempt.route.provider}:${result.attempt.route.requestedModelId}\n\nTask: ${input.taskId}`,
      );

    await this.artifacts.record({
      attemptId: result.attempt.id,
      taskId: input.taskId,
      providerId: result.attempt.route.provider,
      requestedModelId: result.attempt.route.requestedModelId,
      resolvedModelId:
        result.attempt.resolvedModelId ?? input.route.requestedModelId,
      status,
      outputSha256: result.attempt.outputSha256 ?? sha256(result.content),
      patchSha256: status === "accepted" ? sha256(patch) : null,
      changedLines: applied.changedLines,
      verifierId: status === "accepted" ? "isolated-worker-v1" : null,
      reason:
        status === "rejected"
          ? `verification_${verified.status}: ${verificationTail(verified)}`
          : null,
      fallbackReason: input.fallbackReason,
    } satisfies ProviderArtifactInput);

    const decision = classifyAttempt({
      outcome: "succeeded",
      artifactStatus: status,
    });
    return {
      status,
      decision,
      touchedPaths,
      ...(commitSha === undefined ? {} : { commitSha }),
    };
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
