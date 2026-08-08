import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import {
  ExecutableTaskSupervisor,
  type OperationDriver,
} from "../src/operations/execution-supervisor.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// Proves migrations/0009_ai_patch_executor.sql and the self-verifying branch
// in execution-supervisor.ts actually work together against a real Postgres
// database: expected_output_sha256 NULL is legal for driver='ai_patch_executor'
// only, and the supervisor trusts the driver's own { verified } result
// instead of a hash comparison.
test(
  "ai_patch_executor driver: self-verified success and failure both flow through the real supervisor",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const contractId = randomUUID(),
        milestoneId = randomUUID(),
        work = new PostgresWorkRepository(pool);
      await pool.query(
        "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',100000)",
        [contractId, "a".repeat(40)],
      );
      await pool.query(
        "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
        [milestoneId, contractId],
      );

      const acceptedTask = await work.submit({
        contractId,
        milestoneId,
        idempotencyKey: "ai-patch-accepted",
        maxCostUsdMicros: 1000,
        maxAttempts: 1,
      });
      await work.controlTransition(acceptedTask.id, "draft", "queued");
      await pool.query(
        "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'ai_patch_executor',$2,NULL,'ai-patch-executor')",
        [acceptedTask.id, { note: "fixture" }],
      );
      const acceptDriver: OperationDriver = {
        async execute() {
          return { verified: true, status: "accepted" };
        },
      };
      const acceptedResult = await new ExecutableTaskSupervisor(
        pool,
        work,
        new Map([["ai_patch_executor", acceptDriver]]),
        "ai-patch-worker",
        5_000,
      ).runOne(new AbortController().signal);
      assert.equal(acceptedResult?.task.state, "succeeded");

      const rejectedTask = await work.submit({
        contractId,
        milestoneId,
        idempotencyKey: "ai-patch-rejected",
        maxCostUsdMicros: 1000,
        maxAttempts: 1,
      });
      await work.controlTransition(rejectedTask.id, "draft", "queued");
      await pool.query(
        "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'ai_patch_executor',$2,NULL,'ai-patch-executor')",
        [rejectedTask.id, { note: "fixture" }],
      );
      const rejectDriver: OperationDriver = {
        async execute() {
          return { verified: false, status: "rejected" };
        },
      };
      const rejectedResult = await new ExecutableTaskSupervisor(
        pool,
        work,
        new Map([["ai_patch_executor", rejectDriver]]),
        "ai-patch-worker",
        5_000,
      ).runOne(new AbortController().signal);
      assert.equal(rejectedResult?.task.state, "failed");
    } finally {
      await pool.end();
    }
  },
);

test(
  "a deterministic_sha256 spec still requires a non-null expected hash (DB-enforced)",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const contractId = randomUUID(),
        milestoneId = randomUUID(),
        work = new PostgresWorkRepository(pool);
      await pool.query(
        "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',100000)",
        [contractId, "a".repeat(40)],
      );
      await pool.query(
        "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
        [milestoneId, contractId],
      );
      const task = await work.submit({
        contractId,
        milestoneId,
        idempotencyKey: "deterministic-needs-hash",
        maxCostUsdMicros: 1000,
        maxAttempts: 1,
      });
      await assert.rejects(() =>
        pool.query(
          "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'deterministic_sha256',$2,NULL,'x')",
          [task.id, {}],
        ),
      );
    } finally {
      await pool.end();
    }
  },
);
