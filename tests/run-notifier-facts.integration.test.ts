import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { AiGateway } from "../src/gateway/gateway.js";
import { MODEL_POLICY_VERSION } from "../src/gateway/model-policy.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import type { ManagedProviderAdapter } from "../src/gateway/types.js";
import { PostgresProviderArtifactStore } from "../src/operations/provider-artifact-store.js";
import { PostgresRunFacts } from "../src/operations/run-notifier.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// DeepSeek is metered; Codex and Claude are subscription CLIs billing $0 real
// dollars per call (src/gateway/provider-billing.ts). usageFor() used to pick
// the single costliest attempt as the report's headline model -- right for a
// failure, where cost is the only ranking that means anything, but actively
// misleading for a success: a real report read "✅ Patch succeeded ...
// 🤖 deepseek-v4-pro" on a task DeepSeek was rejected on and Codex actually
// solved, because DeepSeek's real charge outranked Codex's $0. Found from a
// live Telegram report, 2026-08-12.
test(
  "a succeeded task's headline names the model that was actually accepted, not the costliest rejection",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const scope = randomUUID(),
        taskId = randomUUID(),
        milestoneId = randomUUID();
      await pool.query(
        "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES($1,1000000)",
        [scope],
      );
      // provider_artifacts.task_id is a real FK -- a bare taskId string isn't
      // enough, unlike ai_gateway_attempts.attribution which is untyped jsonb.
      await pool.query(
        "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',1000000)",
        [scope, "0".repeat(40)],
      );
      await pool.query(
        "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
        [milestoneId, scope],
      );
      await pool.query(
        "INSERT INTO tasks(id,contract_id,milestone_id,idempotency_key,state,max_cost_usd_micros,max_attempts) VALUES($1,$2,$3,$4,'queued',1000000,6)",
        [taskId, scope, milestoneId, `task-${taskId}`],
      );
      const attribution = {
        projectId: "p",
        contractId: scope,
        milestoneId: "m",
        taskId,
        taskAttemptOrdinal: 1,
        agentId: "a",
      };
      const adapter = (
        provider: "deepseek" | "codex",
        model: string,
        costUsdMicros: number,
      ): ManagedProviderAdapter => ({
        provider,
        listModels: async () => [model],
        invoke: async () => ({
          providerRequestId: randomUUID(),
          resolvedModelId: model,
          resolutionSource: "provider_response",
          content: "patch",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros,
          },
          modelUsage: [
            {
              resolvedModelId: model,
              inputTokens: 100,
              outputTokens: 50,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsdMicros,
            },
          ],
        }),
      });

      const ledger = new PostgresAttemptLedger(pool);
      const artifacts = new PostgresProviderArtifactStore(pool);

      // The expensive attempt: real money, and rejected.
      const rejected = await new AiGateway(ledger, [
        adapter("deepseek", "deepseek-v4-pro", 7_400),
      ]).execute({
        idempotencyKey: `rejected-${taskId}`,
        taskClass: "bulk_code",
        attribution,
        messages: [{ role: "user", content: "work" }],
        maxOutputTokens: 200,
        maxCostUsdMicros: 500_000,
        policyVersion: MODEL_POLICY_VERSION,
      });
      await artifacts.record({
        attemptId: rejected.attempt.id,
        taskId,
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        resolvedModelId: "deepseek-v4-pro",
        status: "rejected",
        outputSha256: rejected.attempt.outputSha256!,
        patchSha256: null,
        changedLines: 0,
        verifierId: null,
        reason: "verification_failed: typecheck",
        fallbackReason: null,
      });

      // The free attempt: $0 real dollars (subscription CLI), and accepted.
      const accepted = await new AiGateway(ledger, [
        adapter("codex", "gpt-5.5", 0),
      ]).execute({
        idempotencyKey: `accepted-${taskId}`,
        taskClass: "bulk_code",
        attribution,
        messages: [{ role: "user", content: "work" }],
        maxOutputTokens: 200,
        maxCostUsdMicros: 500_000,
        policyVersion: MODEL_POLICY_VERSION,
      });
      await artifacts.record({
        attemptId: accepted.attempt.id,
        taskId,
        providerId: "codex",
        requestedModelId: "gpt-5.5",
        resolvedModelId: "gpt-5.5",
        status: "accepted",
        outputSha256: accepted.attempt.outputSha256!,
        patchSha256: "b".repeat(64),
        changedLines: 12,
        verifierId: "isolated-worker-v1",
        reason: null,
        fallbackReason: null,
      });

      const facts = new PostgresRunFacts(pool);
      const { usage } = await facts.usageFor(taskId);
      assert.equal(usage?.provider, "codex");
      assert.equal(usage?.model, "gpt-5.5");
      assert.equal(usage?.costUsdMicros, 0);
    } finally {
      await pool.end();
    }
  },
);
