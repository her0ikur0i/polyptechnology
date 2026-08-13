import { randomUUID } from "node:crypto";
import pg from "pg";
import { AiGateway, GatewayInvocationError } from "../src/gateway/gateway.js";
import { DeepSeekAdapter } from "../src/gateway/deepseek-adapter.js";
import {
  ClaudeCliAdapter,
  CodexCliAdapter,
} from "../src/gateway/cli-adapters.js";
import { FileSecretResolver } from "../src/gateway/file-secret-resolver.js";
import {
  MODEL_POLICY_VERSION,
  modelRoutes,
} from "../src/gateway/model-policy.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";

type CanaryResult = {
  provider: string;
  requestedModelId: string;
  ok: boolean;
  detail: string;
};

function parseCanary(content: string): boolean {
  try {
    const parsed = JSON.parse(content.trim()) as {
      ok?: unknown;
      slug?: unknown;
    };
    return parsed.ok === true && parsed.slug === "blueprint-chain-canary";
  } catch {
    return false;
  }
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined)
    throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const results: CanaryResult[] = [];
  try {
    await pool.query(
      "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES('blueprint-chain-canary',5000000) ON CONFLICT(scope_id) DO NOTHING",
    );
    const ledger = new PostgresAttemptLedger(pool);
    const gateway = new AiGateway(ledger, [
      new DeepSeekAdapter(
        process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        "secret://polyp/deepseek/api-key",
        new FileSecretResolver(
          process.env.PROVIDER_SECRETS_FILE ??
            "/root/.config/polyp/provider-secrets.env",
        ),
      ),
      new CodexCliAdapter(),
      new ClaudeCliAdapter(undefined, 3),
    ]);

    for (const [index, route] of modelRoutes("orchestration").entries()) {
      try {
        const result = await gateway.execute({
          idempotencyKey: `blueprint-chain-canary-${index + 1}-${route.provider}-${route.requestedModelId}-${randomUUID()}`,
          taskClass: "orchestration",
          routeOverride: route,
          attribution: {
            projectId: "polyp-ai-factory",
            contractId: "blueprint-chain-canary",
            milestoneId: "activation",
            taskId: "orchestration-chain-canary",
            taskAttemptOrdinal: index + 1,
            agentId: "orchestration-chain-canary",
          },
          messages: [
            {
              role: "system",
              content:
                'Return only compact JSON with schema {"ok":true,"slug":"blueprint-chain-canary"}. No markdown.',
            },
            {
              role: "user",
              content:
                'Return exactly {"ok":true,"slug":"blueprint-chain-canary"}',
            },
          ],
          maxOutputTokens: 512,
          maxCostUsdMicros: 500_000,
          policyVersion: MODEL_POLICY_VERSION,
        });
        const ok = parseCanary(result.content);
        await ledger.recordVerification(
          result.attempt.id,
          ok,
          "blueprint-chain-json-v1",
          result.attempt.outputSha256!,
        );
        results.push({
          provider: route.provider,
          requestedModelId: route.requestedModelId,
          ok,
          detail: ok
            ? "round-trip JSON ok"
            : `unexpected content: ${result.content.slice(0, 120)}`,
        });
      } catch (error) {
        results.push({
          provider: route.provider,
          requestedModelId: route.requestedModelId,
          ok: false,
          detail:
            error instanceof GatewayInvocationError
              ? `${error.message} (attempt outcome=${error.attempt.outcome}, failureCode=${error.attempt.failureCode ?? "n/a"})`
              : error instanceof Error
                ? error.message
                : "unknown failure",
        });
      }
    }

    console.log(JSON.stringify(results, null, 2));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "orchestration canary failed",
  );
  process.exitCode = 1;
});
