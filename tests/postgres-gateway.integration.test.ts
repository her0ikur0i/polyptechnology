import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { AiGateway } from "../src/gateway/gateway.js";
import { GatewayInvocationError } from "../src/gateway/gateway.js";
import { MODEL_POLICY_VERSION } from "../src/gateway/model-policy.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import type { ManagedProviderAdapter } from "../src/gateway/types.js";
import { STRANDED_ATTEMPT_CODE } from "../src/gateway/types.js";
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

// The database is the truth here, not the in-memory model: the twenty rows this
// method exists for are real rows, settled by SQL that has to agree with the
// table's own check constraints (`ai_gateway_attempts_check` ties
// provider_request_id to `succeeded`) and with what `outcome_unknown` means for
// the reservation.
test(
  "stranded dispatched attempts are reclaimed, and their reservation is held",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const scope = `contract-${randomUUID()}`;
      await pool.query(
        "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES($1,1000)",
        [scope],
      );
      const ledger = new PostgresAttemptLedger(pool);
      const attempt = (id: string, key: string) => ({
        id,
        idempotencyKey: key,
        requestHash: "b".repeat(64),
        outcome: "reserved" as const,
        route: {
          provider: "codex" as const,
          requestedModelId: "gpt-5.6-terra",
          role: "integration",
        },
        attribution: {
          projectId: "p",
          contractId: scope,
          milestoneId: "m",
          taskId: "t",
          taskAttemptOrdinal: 1,
          agentId: "a",
        },
        policyVersion: MODEL_POLICY_VERSION,
        reservedCostUsdMicros: 100,
        createdAt: new Date(),
      });
      const strandedId = randomUUID(),
        liveId = randomUUID();
      await ledger.reserve(attempt(strandedId, `stranded-${strandedId}`));
      await ledger.reserve(attempt(liveId, `live-${liveId}`));
      await ledger.dispatched(strandedId);
      await ledger.dispatched(liveId);
      // Backdate rather than sleep: the horizon is deliberately longer than any
      // adapter call, so waiting it out is not a test, it is an outage.
      await pool.query(
        "UPDATE ai_gateway_attempts SET dispatched_at=CURRENT_TIMESTAMP-interval '1 hour' WHERE id=$1",
        [strandedId],
      );

      assert.deepEqual(await ledger.reclaimStranded(1_800_000), [strandedId]);
      const rows = await pool.query<{
        id: string;
        outcome: string;
        failure_code: string | null;
        finalized_at: Date | null;
      }>(
        "SELECT id,outcome,failure_code,finalized_at FROM ai_gateway_attempts WHERE id=ANY($1::uuid[]) ORDER BY id=$2 DESC",
        [[strandedId, liveId], strandedId],
      );
      assert.equal(rows.rows[0]!.outcome, "outcome_unknown");
      assert.equal(rows.rows[0]!.failure_code, STRANDED_ATTEMPT_CODE);
      assert.notEqual(rows.rows[0]!.finalized_at, null);
      // An attempt dispatched moments ago may still have a process behind it.
      assert.equal(rows.rows[1]!.outcome, "dispatched");
      // Both reservations are still held: one is unknown and one is live, and
      // neither is a licence to hand the money back. Releasing the unknown one
      // is reconcileUnknownAsFailed()'s job, and it demands evidence.
      const budget = (
        await pool.query(
          "SELECT spent_usd_micros::int spent,reserved_usd_micros::int reserved FROM ai_budget_accounts WHERE scope_id=$1",
          [scope],
        )
      ).rows[0];
      assert.deepEqual(budget, { spent: 0, reserved: 200 });
      assert.deepEqual(await ledger.reclaimStranded(1_800_000), []);
    } finally {
      await pool.end();
    }
  },
);
