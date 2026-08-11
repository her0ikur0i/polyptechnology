import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  ACTIVE_STATES,
  PostgresCommandFacts,
} from "../src/telegram/command-facts.js";

// The queries behind the closed command set, run against the real schema.
//
// This file exists because of the recurring lesson of CONTRACT-017: the unit
// tests for these commands pass a hand-written fake and therefore only prove
// that the renderer agrees with its author. Every defect this contract has
// actually shipped came from the layer below -- a handler matching outcome
// strings the database never produces, a store whose idempotency check could
// not succeed twice. A read model is exactly that layer.
//
// Assertions are relative, never absolute. The test database is shared, other
// suites insert into these same tables, and a test that asserted "two active
// runs" would pass alone and fail in the full run.

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl !== undefined) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const facts = new PostgresCommandFacts(pool);

  async function insertTask(
    state: string,
    spentUsdMicros = 0,
  ): Promise<string> {
    const contractId = randomUUID();
    const milestoneId = randomUUID();
    const taskId = randomUUID();
    await pool.query(
      "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',100000)",
      [contractId, "b".repeat(40)],
    );
    await pool.query(
      "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
      [milestoneId, contractId],
    );
    await pool.query(
      `INSERT INTO tasks(id,contract_id,milestone_id,idempotency_key,state,max_cost_usd_micros,spent_usd_micros,attempt_count,max_attempts)
       VALUES($1,$2,$3,$4,$5,100000,$6,1,3)`,
      [
        taskId,
        contractId,
        milestoneId,
        `cmd-facts-${taskId}`,
        state,
        spentUsdMicros,
      ],
    );
    return taskId;
  }

  async function insertApproval(expiresAt: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO approval_requests(id,target_kind,target_id,summary,risk,rollback,status,token_hash,expires_at,created_at)
       VALUES($1,'deployment',$2,$3,'high','revert the commit','pending',$4,${expiresAt},now())`,
      [
        id,
        randomUUID(),
        `command facts drill ${id.slice(0, 8)}`,
        randomUUID().replace(/-/g, "").padEnd(64, "0"),
      ],
    );
    return id;
  }

  test("every ACTIVE_STATES entry is a state the schema actually allows", async () => {
    // The highest-value assertion in this file. ACTIVE_STATES is a hand-written
    // list compared against `tasks.state` with `= ANY(...)`, so a state renamed
    // in a migration does not fail loudly -- it silently stops matching, and
    // /status quietly reports an idle factory while work is running. The check
    // constraint is the authority, so ask it directly.
    //
    // Insert one task per state inside a transaction and roll it back: if the
    // constraint rejects any of them, this throws and names the offender.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const state of ACTIVE_STATES) {
        const contractId = randomUUID();
        const milestoneId = randomUUID();
        await client.query(
          "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',1000)",
          [contractId, "c".repeat(40)],
        );
        await client.query(
          "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
          [milestoneId, contractId],
        );
        await client.query(
          `INSERT INTO tasks(id,contract_id,milestone_id,idempotency_key,state,max_cost_usd_micros,max_attempts)
           VALUES($1,$2,$3,$4,$5,1000,3)`,
          [
            randomUUID(),
            contractId,
            milestoneId,
            `state-probe-${state}`,
            state,
          ],
        );
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(
        `ACTIVE_STATES contains a state tasks.state does not accept: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      client.release();
    }
  });

  test("activeRuns joins the spec and the live lease against the real schema", async () => {
    const taskId = await insertTask("running", 12_345);
    await pool.query(
      "INSERT INTO operation_task_specs(task_id,driver,input,role) VALUES($1,'conversation_reply',$2,'assistant')",
      [taskId, { probe: "command-facts" }],
    );
    await pool.query(
      "INSERT INTO task_leases(task_id,worker_id,heartbeat_at,expires_at) VALUES($1,'facts-worker',now(),now() + interval '10 minutes')",
      [taskId],
    );

    // A limit large enough that a shared database does not push the fixture off
    // the end of the page, since the real command asks for 10.
    const runs = await facts.activeRuns(500);
    const mine = runs.find((run) => run.taskId === taskId);
    assert.ok(mine, "the running task is missing from activeRuns");
    assert.equal(mine.state, "running");
    assert.equal(mine.driver, "conversation_reply");
    assert.equal(mine.leasedBy, "facts-worker");
    assert.equal(mine.attemptCount, 1);
    assert.equal(mine.maxAttempts, 3);
    // bigint arrives from pg as a string; the read model is responsible for the
    // conversion, and "12345" would render as $12345.00 if it ever stopped.
    assert.equal(mine.spentUsdMicros, 12_345);
  });

  test("activeRuns omits an expired lease rather than reporting a stale worker", async () => {
    const taskId = await insertTask("leased");
    await pool.query(
      "INSERT INTO task_leases(task_id,worker_id,heartbeat_at,expires_at) VALUES($1,'dead-worker',now() - interval '2 hours',now() - interval '1 hour')",
      [taskId],
    );
    const mine = (await facts.activeRuns(500)).find(
      (run) => run.taskId === taskId,
    );
    assert.ok(mine, "a task whose lease expired is still active work");
    // The task is still in flight -- it is the *worker* attribution that must
    // disappear, because naming a worker that has stopped heartbeating tells
    // the owner to go look at a process that is not there.
    assert.equal(mine.leasedBy, undefined);
  });

  test("activeRuns excludes finished work", async () => {
    const taskId = await insertTask("succeeded");
    assert.equal(
      (await facts.activeRuns(500)).find((run) => run.taskId === taskId),
      undefined,
    );
  });

  test("pendingApprovals returns live ones and drops the expired", async () => {
    const live = await insertApproval("now() + interval '30 minutes'");
    const expired = await insertApproval("now() - interval '5 minutes'");

    const approvals = await facts.pendingApprovals(500);
    const found = approvals.find((approval) => approval.id === live);
    assert.ok(found, "a live pending approval is missing");
    assert.equal(found.targetKind, "deployment");
    assert.equal(found.risk, "high");
    assert.ok(found.expiresAt instanceof Date);
    // An approval whose window closed is not something the owner can answer.
    // Listing it sends them to a message whose buttons no longer work.
    assert.equal(
      approvals.find((approval) => approval.id === expired),
      undefined,
    );
  });

  test("status counts the same approvals /approvals lists", async () => {
    await insertApproval("now() + interval '30 minutes'");
    const [status, listed] = await Promise.all([
      facts.status(),
      facts.pendingApprovals(10_000),
    ]);
    // Two queries, two WHERE clauses, one truth. They drifted apart once
    // already in this contract, in the approval handler.
    assert.equal(status.pendingApprovals, listed.length);
  });

  test("status counts a task in every active state, and no finished ones", async () => {
    const before = await facts.status();
    const baseline = new Map(
      before.states.map((row) => [row.state, row.count]),
    );
    await insertTask("queued");
    await insertTask("queued");
    await insertTask("verifying");
    await insertTask("failed");

    const after = await facts.status();
    const counts = new Map(after.states.map((row) => [row.state, row.count]));
    assert.equal(
      (counts.get("queued") ?? 0) - (baseline.get("queued") ?? 0),
      2,
      "queued work must be visible: accepted-but-not-started is still in flight",
    );
    assert.equal(
      (counts.get("verifying") ?? 0) - (baseline.get("verifying") ?? 0),
      1,
    );
    assert.equal(counts.get("failed"), undefined);
  });

  test("status reads the newest finalized provider attempt", async () => {
    const scopeId = `facts-${randomUUID()}`;
    await pool.query(
      "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros,spent_usd_micros,reserved_usd_micros) VALUES($1,5_000_000,250_000,10_000)",
      [scopeId],
    );
    await pool.query(
      `INSERT INTO ai_gateway_attempts(id,idempotency_key,request_hash,outcome,provider_id,requested_model_id,role,attribution,policy_version,budget_scope_id,reserved_cost_usd_micros,created_at,finalized_at)
       VALUES($1,$2,$3,'failed','claude','claude-sonnet-5','orchestration','{}','v1',$4,1000,now(),now())`,
      [randomUUID(), `facts-${randomUUID()}`, "d".repeat(64), scopeId],
    );

    const status = await facts.status();
    assert.ok(status.lastFinishedAt instanceof Date);
    // Within a minute of now: max(finalized_at) over a table this test just
    // wrote the newest row of. Proves the column exists and is read, which is
    // the whole point -- a typo here renders "last provider call" as absent
    // rather than as an error.
    assert.ok(Date.now() - status.lastFinishedAt.getTime() < 60_000);
  });

  test("budget reports the account arithmetic the owner sees in the bar", async () => {
    const scopeId = `facts-${randomUUID()}`;
    await pool.query(
      "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros,spent_usd_micros,reserved_usd_micros) VALUES($1,5_000_000,250_000,10_000)",
      [scopeId],
    );
    const account = (await facts.budget()).find(
      (row) => row.scopeId === scopeId,
    );
    assert.ok(account, "a budget account is missing from /budget");
    assert.deepEqual(account, {
      scopeId,
      limitUsdMicros: 5_000_000,
      spentUsdMicros: 250_000,
      reservedUsdMicros: 10_000,
    });
  });

  test("the account on the status line is the largest of the ones /budget lists", async () => {
    const [status, accounts] = await Promise.all([
      facts.status(),
      facts.budget(),
    ]);
    const largest = Math.max(...accounts.map((row) => row.limitUsdMicros));
    assert.ok(status.budget, "status has no budget summary");
    assert.equal(status.budget.limitUsdMicros, largest);
  });

  after(() => pool.end());
}
