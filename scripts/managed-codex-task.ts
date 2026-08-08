import pg from "pg";
import { CodexCliAdapter } from "../src/gateway/cli-adapters.js";
import { AiGateway } from "../src/gateway/gateway.js";
import { MODEL_POLICY_VERSION } from "../src/gateway/model-policy.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL,
    prompt = process.argv[2];
  if (
    databaseUrl === undefined ||
    prompt === undefined ||
    prompt.length > 20_000
  )
    throw new Error("invalid managed Codex input");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const gateway = new AiGateway(new PostgresAttemptLedger(pool), [
      new CodexCliAdapter(),
    ]);
    const result = await gateway.execute({
      idempotencyKey: `contract005-codex-${Date.now()}`,
      taskClass: "orchestration",
      attribution: {
        projectId: "polyp-ai-factory",
        contractId: "CONTRACT-005",
        milestoneId: "M2",
        taskId: "codex-canary",
        taskAttemptOrdinal: 1,
        agentId: "codex-managed-integrator",
      },
      messages: [
        {
          role: "system",
          content:
            "Do not modify files or invoke tools. Return only the requested literal text.",
        },
        { role: "user", content: prompt },
      ],
      maxOutputTokens: 64,
      maxCostUsdMicros: 200_000,
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
    error instanceof Error ? error.message : "managed Codex task failed",
  );
  process.exitCode = 1;
});
