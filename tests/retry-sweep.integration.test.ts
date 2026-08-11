import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import {
  ExecutableTaskSupervisor,
  digest,
} from "../src/operations/execution-supervisor.js";

// Proves that a retry which has come due is actually retried.
//
// It was not. `retry_wait` had a working promotion path in the repository and
// no caller, so every task that failed one attempt stopped there for good --
// silently, because the failure had already been reported and nothing reports
// a retry that never happens. Found by /runs on real staging data, not by the
// suite, which is why the test is written against the real database.

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl !== undefined) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const work = new PostgresWorkRepository(pool);

  async function parkedTask(dueAt: string): Promise<string> {
    const contractId = randomUUID();
    const milestoneId = randomUUID();
    await pool.query(
      "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',100000)",
      [contractId, "e".repeat(40)],
    );
    await pool.query(
      "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
      [milestoneId, contractId],
    );
    const task = await work.submit({
      contractId,
      milestoneId,
      idempotencyKey: `retry-sweep-${randomUUID()}`,
      maxCostUsdMicros: 1000,
      maxAttempts: 3,
    });
    const input = { operation: "retry-sweep", projectId: randomUUID() };
    await pool.query(
      "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'deterministic_sha256',$2,$3,'deterministic-verifier')",
      [task.id, input, digest({ sha256: digest(input) })],
    );
    // Park it exactly as a failed attempt does: one attempt spent, a due time,
    // and the state the engine leaves behind.
    await pool.query(
      `UPDATE tasks SET state='retry_wait', attempt_count=1, next_attempt_at=${dueAt} WHERE id=$1`,
      [task.id],
    );
    return task.id;
  }

  function supervisor(): ExecutableTaskSupervisor {
    return new ExecutableTaskSupervisor(
      pool,
      work,
      new Map(),
      `retry-sweep-${randomUUID()}`,
    );
  }

  async function stateOf(taskId: string): Promise<string> {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM tasks WHERE id=$1",
      [taskId],
    );
    return result.rows[0]?.state ?? "missing";
  }

  // These call promoteDueRetries() rather than runOne() on purpose. runOne()
  // leases whichever eligible task sorts first across the *whole* shared test
  // database, so driving it here executed other suites' tasks with a driver
  // map that cannot serve them -- one failure in three runs, passing in
  // isolation both times it was checked. A flaky test in a suite whose whole
  // discipline is "zero skips and a trustworthy count" is worse than a
  // narrower one. That the sweep is wired into runOne() was proven where it
  // matters: three real tasks moved out of retry_wait on staging the moment
  // the fix deployed (evidence/retry-sweep.md).

  test("a retry that has come due leaves retry_wait", async () => {
    const taskId = await parkedTask("now() - interval '1 hour'");
    await supervisor().promoteDueRetries();
    // Deliberately "not retry_wait" rather than "queued". Once promoted the
    // task is ordinary eligible work, and a supervisor in a concurrently
    // running suite may legitimately lease and finish it before this line
    // runs. Pinning the exact next state would be asserting that nothing else
    // in the system is working, which is not the property under test.
    assert.notEqual(
      await stateOf(taskId),
      "retry_wait",
      "a due retry was never re-queued",
    );
  });

  test("a retry that is not yet due is left alone", async () => {
    const taskId = await parkedTask("now() + interval '1 hour'");
    await supervisor().promoteDueRetries();
    // Retrying early would defeat the backoff, which exists so a failing
    // provider is not hammered.
    assert.equal(await stateOf(taskId), "retry_wait");
  });

  test("a promoted retry keeps its attempt count, so it still exhausts", async () => {
    const taskId = await parkedTask("now() - interval '1 hour'");
    await supervisor().promoteDueRetries();
    const result = await pool.query<{ attempt_count: number }>(
      "SELECT attempt_count FROM tasks WHERE id=$1",
      [taskId],
    );
    // A sweep that reset the counter would turn a permanently failing task
    // into an infinite retry loop against a paid provider -- a worse bug than
    // the one being fixed. It may have been incremented by an execution that
    // followed; what must never happen is it going backwards.
    assert.ok((result.rows[0]?.attempt_count ?? 0) >= 1);
  });

  after(() => pool.end());
}
