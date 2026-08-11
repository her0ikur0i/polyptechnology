import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL work repository persists attempts, backoff, costs, budgets, and emergency recovery",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const contractId = randomUUID(),
        milestoneId = randomUUID();
      await pool.query(
        "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',100)",
        [contractId, "a".repeat(40)],
      );
      await pool.query(
        "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
        [milestoneId, contractId],
      );
      const repo = new PostgresWorkRepository(pool);
      const first = await repo.submit({
        contractId,
        milestoneId,
        idempotencyKey: "first",
        maxCostUsdMicros: 100,
        maxAttempts: 3,
      });
      assert.equal(
        (
          await repo.submit({
            contractId,
            milestoneId,
            idempotencyKey: "first",
            maxCostUsdMicros: 100,
            maxAttempts: 3,
          })
        ).id,
        first.id,
      );
      await repo.controlTransition(first.id, "draft", "queued");
      const lease = await repo.lease(first.id, "worker", 5_000);
      assert.equal(lease.attemptOrdinal, 1);
      await repo.transition(first.id, lease.fencingToken, "leased", "running");
      const costOne = randomUUID();
      const costTwo = randomUUID();
      assert.equal(
        (await repo.recordCost(first.id, lease.attemptOrdinal, costOne, 60))
          .spentUsdMicros,
        60,
      );
      assert.equal(
        (await repo.recordCost(first.id, lease.attemptOrdinal, costOne, 60))
          .spentUsdMicros,
        60,
      );
      assert.equal(
        (await repo.fail(first.id, lease.fencingToken, "rate_limit", 60_000))
          .state,
        "retry_wait",
      );
      await assert.rejects(
        repo.controlTransition(first.id, "retry_wait", "queued"),
        /backoff/,
      );
      await pool.query(
        "UPDATE tasks SET next_attempt_at=CURRENT_TIMESTAMP WHERE id=$1",
        [first.id],
      );
      // The moment this task becomes due, any supervisor running concurrently
      // in another suite may sweep it back to `queued` first -- that is the
      // point of the sweep. What this test asserts is the transition's own
      // rule: refused while the backoff holds, allowed once it does not.
      const promoted = await pool.query<{ state: string }>(
        "SELECT state FROM tasks WHERE id=$1",
        [first.id],
      );
      if (promoted.rows[0]?.state === "retry_wait")
        await repo.controlTransition(first.id, "retry_wait", "queued");
      const second = await repo.submit({
        contractId,
        milestoneId,
        idempotencyKey: "second",
        maxCostUsdMicros: 100,
        maxAttempts: 2,
      });
      await repo.controlTransition(second.id, "draft", "queued");
      const secondLease = await repo.lease(second.id, "worker", 5_000);
      await repo.transition(
        second.id,
        secondLease.fencingToken,
        "leased",
        "running",
      );
      await repo.setEmergencyStop(true);
      assert.equal(
        (await pool.query("SELECT state FROM tasks WHERE id=$1", [second.id]))
          .rows[0].state,
        "queued",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM task_leases")).rows[0]
          .n,
        0,
      );
      await repo.setEmergencyStop(false);
      await repo.recordCost(first.id, lease.attemptOrdinal, costTwo, 40);
      assert.equal(
        (await pool.query("SELECT state FROM tasks WHERE id=$1", [second.id]))
          .rows[0].state,
        "budget_blocked",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT spent_usd_micros::int AS n FROM factory_contracts WHERE id=$1",
            [contractId],
          )
        ).rows[0].n,
        100,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT failure_reason FROM task_attempts WHERE task_id=$1 AND ordinal=1",
            [first.id],
          )
        ).rows[0].failure_reason,
        "rate_limit",
      );
    } finally {
      await pool.end();
    }
  },
);
