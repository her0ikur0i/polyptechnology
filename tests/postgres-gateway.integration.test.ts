import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { AiGateway } from "../src/gateway/gateway.js";
import { GatewayInvocationError } from "../src/gateway/gateway.js";
import { MODEL_POLICY_VERSION } from "../src/gateway/model-policy.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import type { ManagedProviderAdapter } from "../src/gateway/types.js";
const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL gateway atomically reserves finalizes and protects usage",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const scope = `contract-${randomUUID()}`,
        key = `key-${randomUUID()}`;
      await pool.query(
        "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES($1,100)",
        [scope],
      );
      const adapter: ManagedProviderAdapter = {
        provider: "deepseek",
        listModels: async () => ["deepseek-v4-flash"],
        invoke: async () => ({
          providerRequestId: randomUUID(),
          resolvedModelId: "deepseek-v4-flash",
          resolutionSource: "provider_response",
          content: "managed",
          usage: {
            inputTokens: 5,
            outputTokens: 1,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 7,
          },
          modelUsage: [
            {
              resolvedModelId: "deepseek-v4-flash",
              inputTokens: 5,
              outputTokens: 1,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsdMicros: 7,
            },
          ],
        }),
      };
      const gateway = new AiGateway(new PostgresAttemptLedger(pool), [adapter]);
      const result = await gateway.execute({
        idempotencyKey: key,
        taskClass: "bulk_code",
        attribution: {
          projectId: "p",
          contractId: scope,
          milestoneId: "m",
          taskId: "t",
          taskAttemptOrdinal: 1,
          agentId: "a",
        },
        messages: [{ role: "user", content: "work" }],
        maxOutputTokens: 10,
        maxCostUsdMicros: 20,
        policyVersion: MODEL_POLICY_VERSION,
      });
      assert.equal(result.attempt.resolvedModelId, "deepseek-v4-flash");
      const budget = (
        await pool.query(
          "SELECT spent_usd_micros::int spent,reserved_usd_micros::int reserved FROM ai_budget_accounts WHERE scope_id=$1",
          [scope],
        )
      ).rows[0];
      assert.deepEqual(budget, { spent: 7, reserved: 0 });
      const ledger = new PostgresAttemptLedger(pool);
      const verification = await ledger.recordVerification(
        result.attempt.id,
        true,
        "deterministic-test",
        result.attempt.outputSha256!,
      );
      assert.equal(verification.passed, true);
      await assert.rejects(
        ledger.recordVerification(
          result.attempt.id,
          true,
          "again",
          result.attempt.outputSha256!,
        ),
        /already/,
      );
      const rejectedGateway = new AiGateway(ledger, [
        {
          ...adapter,
          invoke: async () => ({
            providerRequestId: randomUUID(),
            resolvedModelId: "deepseek-v4-flash",
            resolutionSource: "provider_response",
            content: "",
            usage: {
              inputTokens: 5,
              outputTokens: 1,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsdMicros: 7,
            },
            modelUsage: [
              {
                resolvedModelId: "deepseek-v4-flash",
                inputTokens: 5,
                outputTokens: 1,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsdMicros: 7,
              },
            ],
          }),
        },
      ]);
      await assert.rejects(
        rejectedGateway.execute({
          idempotencyKey: `rejected-${randomUUID()}`,
          taskClass: "bulk_code",
          attribution: {
            projectId: "p",
            contractId: scope,
            milestoneId: "m",
            taskId: "rejected",
            taskAttemptOrdinal: 1,
            agentId: "a",
          },
          messages: [{ role: "user", content: "work" }],
          maxOutputTokens: 10,
          maxCostUsdMicros: 20,
          policyVersion: MODEL_POLICY_VERSION,
        }),
        (error) =>
          error instanceof GatewayInvocationError &&
          error.attempt.outcome === "failed" &&
          error.attempt.usage?.costUsdMicros === 7,
      );
      const afterRejected = (
        await pool.query(
          "SELECT spent_usd_micros::int spent,reserved_usd_micros::int reserved FROM ai_budget_accounts WHERE scope_id=$1",
          [scope],
        )
      ).rows[0];
      assert.deepEqual(afterRejected, { spent: 14, reserved: 0 });
      await assert.rejects(
        pool.query(
          "UPDATE ai_usage_events SET input_tokens=99 WHERE attempt_id=$1",
          [result.attempt.id],
        ),
        /immutable/,
      );
      await assert.rejects(
        gateway.execute({
          ...{
            idempotencyKey: key,
            taskClass: "bulk_code" as const,
            attribution: {
              projectId: "p",
              contractId: scope,
              milestoneId: "m",
              taskId: "t",
              taskAttemptOrdinal: 1,
              agentId: "a",
            },
            messages: [{ role: "user" as const, content: "changed" }],
            maxOutputTokens: 10,
            maxCostUsdMicros: 20,
            policyVersion: MODEL_POLICY_VERSION,
          },
        }),
        /idempotency intent mismatch/,
      );
    } finally {
      await pool.end();
    }
  },
);
