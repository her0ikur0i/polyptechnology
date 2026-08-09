import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
import { modelRoutes, MODEL_POLICY_VERSION } from "../gateway/model-policy.js";
import type { ConversationReplyTaskInput } from "../operations/conversation-reply-driver.js";
import { deterministicUuid } from "../deterministic-id.js";

export interface ReplyTaskResult {
  taskId: string;
}

// Mirrors src/factory/generation-task.ts's pattern exactly: a fresh
// project-scoped work-tracking contract/milestone/budget triple (generic
// UUID keys, not this control plane's own CONTRACT-NNN numbering), scoped
// per *conversation* here rather than per generated project, since a
// conversation can exist and accumulate real AiGateway spend well before
// any project blueprint -- let alone a generation contract -- is real.
export async function queueConversationReply(
  pool: Pool,
  input: {
    conversationId: string;
    projectId: string;
    expectedVersion: number;
  },
): Promise<ReplyTaskResult> {
  const work = new PostgresWorkRepository(pool);
  // Deterministic per-conversation, not per-message -- every reply in the
  // same conversation shares one budget scope, matching one conversation
  // costing money as a single ongoing unit of work.
  const contractId = deterministicUuid(
      `conversation:${input.conversationId}:contract`,
    ),
    milestoneId = deterministicUuid(
      `conversation:${input.conversationId}:milestone`,
    );
  await pool.query(
    "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',$3) ON CONFLICT (id) DO NOTHING",
    [contractId, "0".repeat(40), 5_000_000],
  );
  await pool.query(
    "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active') ON CONFLICT (id) DO NOTHING",
    [milestoneId, contractId],
  );
  await pool.query(
    "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES($1,$2) ON CONFLICT (scope_id) DO NOTHING",
    [contractId, 5_000_000],
  );

  const task = await work.submit({
    contractId,
    milestoneId,
    idempotencyKey: `conversation-reply-${randomUUID()}`,
    maxCostUsdMicros: 5_000_000,
    maxAttempts: 3,
  });
  await work.controlTransition(task.id, "draft", "queued");

  const staticRoute = modelRoutes("orchestration")[0];
  if (staticRoute === undefined)
    throw new Error("no static orchestration route");

  const specInput: ConversationReplyTaskInput = {
    conversationId: input.conversationId,
    projectId: input.projectId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: `conversation-reply-${task.id}`,
    attribution: {
      projectId: input.projectId,
      contractId,
      milestoneId,
      taskId: task.id,
      taskAttemptOrdinal: 1,
      agentId: "conversation-interview",
    },
    // Conversational replies are shorter and cheaper than a full code
    // patch (bulk_code's 8,000/500,000 in generation-task.ts) -- bounded
    // separately so one runaway conversation can't silently consume the
    // same budget envelope as real code generation.
    maxOutputTokens: 4_000,
    maxCostUsdMicros: 200_000,
    policyVersion: MODEL_POLICY_VERSION,
    route: staticRoute,
  };

  await pool.query(
    "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'conversation_reply',$2,NULL,'conversation-interview')",
    [task.id, specInput],
  );

  return { taskId: task.id };
}
