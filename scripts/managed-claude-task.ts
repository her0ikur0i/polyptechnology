import pg from "pg";
import { ClaudeCliAdapter } from "../src/gateway/cli-adapters.js";
import { AiGateway } from "../src/gateway/gateway.js";
import { MODEL_POLICY_VERSION } from "../src/gateway/model-policy.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import type { TaskClass } from "../src/gateway/types.js";
const allowed = new Set<TaskClass>(["specialist_review", "critical_review"]);
async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL,
    contractId = process.env.MANAGED_CONTRACT_ID,
    milestoneId = process.env.MANAGED_MILESTONE_ID,
    taskClass = process.argv[2] as TaskClass,
    prompt = process.argv[3];
  if (
    databaseUrl === undefined ||
    contractId === undefined ||
    !/^CONTRACT-[0-9]{3}$/.test(contractId) ||
    milestoneId === undefined ||
    !/^M[0-9]+$/.test(milestoneId) ||
    !allowed.has(taskClass) ||
    prompt === undefined ||
    prompt.length > 100_000
  )
    throw new Error("invalid managed review input");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const gateway = new AiGateway(new PostgresAttemptLedger(pool), [
      new ClaudeCliAdapter(undefined, 10),
    ]);
    const result = await gateway.execute({
      idempotencyKey: `${contractId}-${milestoneId}-review-${Date.now()}`,
      taskClass,
      attribution: {
        projectId: "polyp-ai-factory",
        contractId,
        milestoneId,
        taskId: "managed-claude-task",
        taskAttemptOrdinal: 1,
        agentId: "claude-managed-worker",
      },
      messages: [
        {
          role: "system",
          content:
            "Perform a bounded independent security review. Do not edit files or request secrets.",
        },
        { role: "user", content: prompt },
      ],
      maxOutputTokens: 8000,
      maxCostUsdMicros: 2_000_000,
      policyVersion: MODEL_POLICY_VERSION,
    });
    console.log(
      JSON.stringify({
        attemptId: result.attempt.id,
        provider: result.attempt.route.provider,
        requestedModelId: result.attempt.route.requestedModelId,
        resolvedModelId: result.attempt.resolvedModelId,
        usage: result.attempt.usage,
        outcome: result.attempt.outcome,
        content: result.content,
      }),
    );
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "managed review failed",
  );
  process.exitCode = 1;
});
