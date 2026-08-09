import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { PostgresPolicyStore } from "../src/policy/postgres-policy-store.js";
import { OwnerPolicyService } from "../src/policy/owner-policy-service.js";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  test("skipped - TEST_DATABASE_URL not set", () => {
    assert.ok(true);
  });
} else {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const csrfSecret = "a".repeat(32);

  async function makeTask(): Promise<string> {
    const contractId = randomUUID();
    const milestoneId = randomUUID();
    await pool.query(
      "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',$3)",
      [contractId, "0".repeat(40), 2_000_000],
    );
    await pool.query(
      "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
      [milestoneId, contractId],
    );
    const work = new PostgresWorkRepository(pool);
    const task = await work.submit({
      contractId,
      milestoneId,
      idempotencyKey: `override-test-${randomUUID()}`,
      maxCostUsdMicros: 2_000_000,
      maxAttempts: 6,
    });
    return task.id;
  }

  test("insertOverride persists a row readable by findActiveOverride", async () => {
    const store = new PostgresPolicyStore(pool);
    const taskId = await makeTask();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const before = await store.findActiveOverride(taskId);
    assert.equal(before, undefined);

    await store.insertOverride({
      id: randomUUID(),
      taskId,
      ownerId: "owner-1",
      reason: "verified deepseek+codex failure, escalating by hand",
      expiresAt,
      occurredAt: new Date(),
    });

    const found = await store.findActiveOverride(taskId);
    assert.ok(found);
    assert.equal(found!.task_id, taskId);
    assert.equal(found!.owner_id, "owner-1");
    assert.equal(found!.expires_at.toISOString(), expiresAt.toISOString());
  });

  test("findActiveOverride ignores expired overrides", async () => {
    const store = new PostgresPolicyStore(pool);
    const taskId = await makeTask();

    // task_role_overrides is append-only (immutable trigger, migration 0008)
    // -- an expired override is created directly with expiresAt in the past,
    // not by mutating a previously-active row.
    await store.insertOverride({
      id: randomUUID(),
      taskId,
      ownerId: "owner-1",
      reason: "expired override should not be picked up",
      expiresAt: new Date(Date.now() - 60 * 1000),
      occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    const found = await store.findActiveOverride(taskId);
    assert.equal(found, undefined);
  });

  test("OwnerPolicyService.createCodexOverride persists and is later found", async () => {
    const store = new PostgresPolicyStore(pool);
    const service = new OwnerPolicyService(store, csrfSecret);
    const taskId = await makeTask();
    const occurredAt = new Date().toISOString();

    const result = await service.createCodexOverride(
      { authenticated: true, actorId: "owner-1", csrfToken: csrfSecret },
      {
        taskId,
        reason: "manual escalation after two verified deepseek failures",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        occurredAt,
      },
    );
    assert.equal(result.taskId, taskId);
    assert.ok(result.id);

    const active = await store.findActiveOverride(taskId);
    assert.ok(active);
    assert.equal(
      active!.reason,
      "manual escalation after two verified deepseek failures",
    );
  });

  test("createCodexOverride rejects unknown task id (FK enforced)", async () => {
    const store = new PostgresPolicyStore(pool);
    const service = new OwnerPolicyService(store, csrfSecret);
    await assert.rejects(
      service.createCodexOverride(
        { authenticated: true, actorId: "owner-1", csrfToken: csrfSecret },
        {
          taskId: randomUUID(),
          reason: "task does not exist",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          occurredAt: new Date().toISOString(),
        },
      ),
    );
  });

  after(() => pool.end());
}
