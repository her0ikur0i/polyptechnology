import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
import { modelRoutes, MODEL_POLICY_VERSION } from "../gateway/model-policy.js";
import { verificationCommandFor } from "../operations/verification-image-policy.js";
import type { BlueprintDocument, GeneratedProject } from "./types.js";

export interface GenerationTaskResult {
  taskId: string;
  contractId: string;
  milestoneId: string;
}

// The producer M2's AiPatchExecutorDriver always needed and never had:
// creates a real tasks/operation_task_specs row (driver='ai_patch_executor')
// from a real blueprint, so ExecutableTaskSupervisor can actually lease and
// run it. factory_contracts/milestones here are a fresh, project-scoped
// unit of work -- not this repo's own CONTRACT-NNN numbering (that pattern
// was already established by the CONTRACT-010 synthetic-project acceptance
// test: factory_contracts.id is a generic UUID work-tracking key, reusable
// per generated project, not exclusive to this control plane's own
// contracts).
export async function createGenerationTask(
  pool: Pool,
  project: GeneratedProject,
  blueprint: BlueprintDocument,
  repoPath: string,
): Promise<GenerationTaskResult> {
  const work = new PostgresWorkRepository(pool);
  const contractId = randomUUID(),
    milestoneId = randomUUID();
  await pool.query(
    "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',$3)",
    [contractId, "0".repeat(40), 2_000_000],
  );
  await pool.query(
    "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
    [milestoneId, contractId],
  );
  // AiGateway.execute()'s reservation (src/gateway/postgres-ledger.ts) is
  // scoped to attribution.contractId -- without a budget account row for
  // this freshly-generated contractId, every attempt fails closed with
  // "gateway budget unavailable or exhausted" before any provider is ever
  // called.
  await pool.query(
    "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES($1,$2) ON CONFLICT (scope_id) DO NOTHING",
    [contractId, 2_000_000],
  );

  const task = await work.submit({
    contractId,
    milestoneId,
    idempotencyKey: `generate-${project.id}`,
    maxCostUsdMicros: 2_000_000,
    maxAttempts: 6, // enough to walk deepseek(x2) -> codex(x2) -> claude
  });
  await work.controlTransition(task.id, "draft", "queued");

  const verifyDir = await mkdtemp(join(tmpdir(), "polyp-generate-verify-"));
  const verify = verificationCommandFor("bulk_code");
  const staticRoute = modelRoutes("bulk_code")[0];
  if (staticRoute === undefined) throw new Error("no static bulk_code route");

  const input = {
    taskId: task.id,
    taskClass: "bulk_code" as const,
    idempotencyKey: `generate-${project.id}-${task.attemptCount + 1}`,
    attribution: {
      projectId: project.id,
      contractId,
      milestoneId,
      taskId: task.id,
      taskAttemptOrdinal: 1,
      agentId: "factory-generation",
    },
    messages: [
      {
        role: "system" as const,
        content:
          "You are implementing the initial scaffold for a new project. " +
          "Return a single unified diff (git apply-compatible) against the " +
          "existing repository. Only touch files inside this repository.",
      },
      {
        role: "user" as const,
        content: [
          `Project: ${blueprint.displayName} (${blueprint.slug})`,
          `Stack: ${blueprint.stack.runtime}/${blueprint.stack.framework}/${blueprint.stack.database}`,
          "Requirements:",
          ...blueprint.requirements.map((r) => `- ${r}`),
          "",
          "The repository already has package.json (typecheck/format:check/test " +
            "scripts), tsconfig.json, and a placeholder test. Implement the " +
            "requirements above as real, working, tested TypeScript.",
        ].join("\n"),
      },
    ],
    maxOutputTokens: 8_000,
    maxCostUsdMicros: 500_000,
    policyVersion: MODEL_POLICY_VERSION,
    route: staticRoute,
    ownedPaths: "unscoped" as const,
    workspaceRoot: repoPath,
    verifyJob: {
      isolationRoot: tmpdir(),
      workspaceRoot: verifyDir,
      image: verify.image,
      command: verify.command,
      args: verify.args,
      // Nothing in the verify chain (typecheck/format:check/test) writes a
      // dedicated report file -- package.json always exists post-verify and
      // is harmless to hash as the nominal collected artifact.
      // collectArtifacts() (src/worker/artifacts.ts) requires every declared
      // path to exist, and planWorker() requires at least one declared path.
      ownedPaths: ["package.json"],
      capabilities: [] as const,
      timeoutMs: 300_000,
      outputByteLimit: 1_000_000,
      memoryMb: 1024,
      cpuLimit: 1,
      environment: { CI: "true" },
    },
    fallbackReason: null,
  };

  await pool.query(
    "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'ai_patch_executor',$2,NULL,'factory-generation')",
    [task.id, input],
  );

  return { taskId: task.id, contractId, milestoneId };
}
