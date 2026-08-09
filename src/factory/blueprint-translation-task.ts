import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
import { modelRoutes, MODEL_POLICY_VERSION } from "../gateway/model-policy.js";
import type { BlueprintTranslationTaskInput } from "../operations/blueprint-translation-driver.js";
import { deterministicUuid } from "../deterministic-id.js";

export interface BlueprintTranslationTaskResult {
  taskId: string;
}

// Mirrors src/orchestrator/reply-task.ts's pattern exactly -- a fresh
// work-tracking contract/milestone/budget triple, scoped per *proposal*
// here (translation happens once per handed-off proposal, not per
// message), queued for the same background supervisor that already runs
// conversation_reply and ai_patch_executor tasks.
export async function queueBlueprintTranslation(
  pool: Pool,
  input: {
    projectId: string;
    proposalId: string;
    contractCandidate: string;
    expectedProjectVersion: number;
  },
): Promise<BlueprintTranslationTaskResult> {
  const work = new PostgresWorkRepository(pool);
  const contractId = deterministicUuid(`proposal:${input.proposalId}:contract`),
    milestoneId = deterministicUuid(`proposal:${input.proposalId}:milestone`);
  await pool.query(
    "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',$3) ON CONFLICT (id) DO NOTHING",
    [contractId, "0".repeat(40), 1_000_000],
  );
  await pool.query(
    "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active') ON CONFLICT (id) DO NOTHING",
    [milestoneId, contractId],
  );
  await pool.query(
    "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES($1,$2) ON CONFLICT (scope_id) DO NOTHING",
    [contractId, 1_000_000],
  );

  const task = await work.submit({
    contractId,
    milestoneId,
    idempotencyKey: `blueprint-translation-${randomUUID()}`,
    maxCostUsdMicros: 1_000_000,
    maxAttempts: 3,
  });
  await work.controlTransition(task.id, "draft", "queued");

  const staticRoute = modelRoutes("orchestration")[0];
  if (staticRoute === undefined)
    throw new Error("no static orchestration route");

  const specInput: BlueprintTranslationTaskInput = {
    projectId: input.projectId,
    contractCandidate: input.contractCandidate,
    expectedProjectVersion: input.expectedProjectVersion,
    idempotencyKey: `blueprint-translation-${task.id}`,
    attribution: {
      projectId: input.projectId,
      contractId,
      milestoneId,
      taskId: task.id,
      taskAttemptOrdinal: 1,
      agentId: "conversation-interview",
    },
    maxOutputTokens: 2_000,
    maxCostUsdMicros: 150_000,
    policyVersion: MODEL_POLICY_VERSION,
    route: staticRoute,
  };

  await pool.query(
    "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'blueprint_translation',$2,NULL,'conversation-interview')",
    [task.id, specInput],
  );

  return { taskId: task.id };
}
