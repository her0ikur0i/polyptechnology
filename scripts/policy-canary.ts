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
import { PostgresPolicyStore } from "../src/policy/postgres-policy-store.js";
import type { ModelRoute, TaskClass } from "../src/gateway/types.js";

const ALL_TASK_CLASSES: readonly TaskClass[] = [
  "bulk_code",
  "complex_backend",
  "bounded_repair",
  "orchestration",
  "light_review",
  "specialist_review",
  "critical_review",
  "independent_review",
];

function distinctRoutes(): Array<{ taskClass: TaskClass; route: ModelRoute }> {
  const seen = new Map<string, { taskClass: TaskClass; route: ModelRoute }>();
  for (const taskClass of ALL_TASK_CLASSES)
    for (const route of modelRoutes(taskClass)) {
      const key = `${route.provider}:${route.requestedModelId}`;
      if (!seen.has(key)) seen.set(key, { taskClass, route });
    }
  return [...seen.values()];
}

interface CanaryResult {
  provider: string;
  requestedModelId: string;
  ok: boolean;
  detail: string;
}

// Synchronization pre-flight for every (provider, requestedModelId) pair
// registered across the current MODEL_POLICY_VERSION routing table. This is
// meant to gate policy activation (draft -> validated) with a live check,
// not just the structural JSON validation validatePolicy() already does --
// it catches adapter/envelope-parsing bugs (e.g. the CONTRACT-011 Claude CLI
// envelope incident) before a real task ever depends on that route.
async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined)
    throw new Error("TEST_DATABASE_URL is required");
  const only = process.argv[2]; // optional filter: "deepseek" | "codex" | "claude"
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const results: CanaryResult[] = [];
  try {
    await pool.query(
      "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES('CONTRACT-011',5000000) ON CONFLICT(scope_id) DO NOTHING",
    );
    const ledger = new PostgresAttemptLedger(pool);
    const gateway = new AiGateway(ledger, [
      new DeepSeekAdapter(
        process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        "secret://polyp/deepseek/api-key",
        new FileSecretResolver("/root/.config/polyp/provider-secrets.env"),
      ),
      new CodexCliAdapter(),
      new ClaudeCliAdapter(undefined, 3),
    ]);
    for (const { taskClass, route } of distinctRoutes()) {
      if (only && route.provider !== only) continue;
      try {
        const result = await gateway.execute({
          idempotencyKey: `canary-${route.provider}-${route.requestedModelId}-${randomUUID()}`,
          taskClass,
          routeOverride: route,
          attribution: {
            projectId: "polyp-ai-factory",
            contractId: "CONTRACT-011",
            milestoneId: "M-canary",
            taskId: "policy-canary",
            taskAttemptOrdinal: 1,
            agentId: "policy-canary",
          },
          messages: [
            {
              role: "system",
              content: "Return only the requested literal text.",
            },
            { role: "user", content: "Reply exactly: MANAGED_GATEWAY_OK" },
          ],
          // Thinking-mode routes spend part of this budget on reasoning
          // tokens before any answer text -- a too-tight budget starves the
          // final content to empty and fails accounting validation, which is
          // what actually happened to deepseek-v4-pro in the CONTRACT-011
          // M1 log incident. 512 leaves headroom for reasoning + a two-word
          // literal reply across every registered route.
          maxOutputTokens: 512,
          maxCostUsdMicros: 200_000,
          policyVersion: MODEL_POLICY_VERSION,
        });
        const passed = result.content.trim() === "MANAGED_GATEWAY_OK";
        await ledger.recordVerification(
          result.attempt.id,
          passed,
          "literal-output-v1",
          result.attempt.outputSha256!,
        );
        results.push({
          provider: route.provider,
          requestedModelId: route.requestedModelId,
          ok: passed,
          detail: passed
            ? "round-trip ok"
            : `unexpected content: ${result.content.slice(0, 80)}`,
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
    if (results.some((r) => !r.ok)) {
      process.exitCode = 1;
      return;
    }

    // CONTRACT-015 M4: the canary now writes durable evidence instead of only
    // printing to a terminal that nobody is required to read.
    // PostgresPolicyStore.validate() refuses to advance a draft without a
    // passing record bound to that policy's sha256, so this is what turns a
    // remembered pre-flight into an enforced gate.
    //
    // Recording is skipped when POLICY_ID/POLICY_VERSION are absent, because
    // the script is also useful as a bare connectivity check against no
    // particular draft. It is never skipped silently on failure: a failing run
    // returned above without writing anything.
    const policyId = process.env.POLICY_ID;
    const policyVersion = process.env.POLICY_VERSION;
    if (policyId === undefined || policyVersion === undefined) {
      console.error(
        "canary passed; set POLICY_ID and POLICY_VERSION to record evidence against a draft",
      );
      return;
    }
    if (only !== undefined)
      throw new Error(
        "refusing to record evidence from a provider-filtered run: validate() requires every registered route to have passed",
      );

    await new PostgresPolicyStore(pool).recordCanaryEvidence(
      policyId,
      Number(policyVersion),
      process.env.POLICY_CANARY_ACTOR ?? "policy-canary",
      new Date(),
      results,
    );
    console.error(
      `recorded canary evidence for policy ${policyId} v${policyVersion} (${results.length} routes)`,
    );
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "policy canary failed",
  );
  process.exitCode = 1;
});
