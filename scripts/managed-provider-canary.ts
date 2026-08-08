import pg from "pg";
import { AiGateway } from "../src/gateway/gateway.js";
import { DeepSeekAdapter } from "../src/gateway/deepseek-adapter.js";
import { FileSecretResolver } from "../src/gateway/file-secret-resolver.js";
import { MODEL_POLICY_VERSION } from "../src/gateway/model-policy.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import { providerSummary } from "../src/gateway/summary.js";
async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined)
    throw new Error("TEST_DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES('CONTRACT-005',1000000) ON CONFLICT(scope_id) DO NOTHING",
    );
    const ledger = new PostgresAttemptLedger(pool);
    const gateway = new AiGateway(ledger, [
      new DeepSeekAdapter(
        process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        "secret://polyp/deepseek/api-key",
        new FileSecretResolver("/root/.config/polyp/provider-secrets.env"),
      ),
    ]);
    const result = await gateway.execute({
      idempotencyKey: `contract005-canary-${Date.now()}`,
      taskClass: "bulk_code",
      attribution: {
        projectId: "polyp-ai-factory",
        contractId: "CONTRACT-005",
        milestoneId: "M2",
        taskId: "provider-canary",
        taskAttemptOrdinal: 1,
        agentId: "managed-gateway",
      },
      messages: [
        { role: "system", content: "Return only the requested literal text." },
        { role: "user", content: "Reply exactly: MANAGED_GATEWAY_OK" },
      ],
      maxOutputTokens: 32,
      maxCostUsdMicros: 1000,
      policyVersion: MODEL_POLICY_VERSION,
    });
    const passed = result.content.trim() === "MANAGED_GATEWAY_OK";
    const verification = await ledger.recordVerification(
      result.attempt.id,
      passed,
      "literal-output-v1",
      result.attempt.outputSha256!,
    );
    if (!passed) throw new Error("provider canary output verification failed");
    console.log(JSON.stringify(providerSummary(result.attempt, verification)));
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "canary failed");
  process.exitCode = 1;
});
