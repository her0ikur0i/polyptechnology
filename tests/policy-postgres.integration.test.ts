import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { PostgresPolicyStore } from "../src/policy/postgres-policy-store.js";
import type { RuntimePolicy } from "../src/policy/types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  test("skipped - TEST_DATABASE_URL not set", () => {
    assert.ok(true);
  });
} else {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });

  function makeValidPolicy(concurrency: number): RuntimePolicy {
    return {
      routesByTaskClass: {
        bulk_code: [
          {
            provider: "deepseek",
            requestedModelId: "deepseek-v4-flash",
            priority: 0,
          },
          {
            provider: "claude",
            requestedModelId: "claude-sonnet-5",
            priority: 1,
          },
        ],
        complex_backend: [
          {
            provider: "deepseek",
            requestedModelId: "deepseek-v4-pro",
            priority: 0,
          },
          {
            provider: "claude",
            requestedModelId: "claude-opus-4-8",
            priority: 1,
          },
        ],
        bounded_repair: [
          {
            provider: "deepseek",
            requestedModelId: "deepseek-v4-flash",
            priority: 0,
          },
          {
            provider: "claude",
            requestedModelId: "claude-sonnet-5",
            priority: 1,
          },
        ],
      },
      envelope: {
        softBudgetUsdMicros: 1000000,
        emergencyCostCeilingUsdMicros: 2000000,
        maxOutputTokens: 100000,
        maxTurns: 50,
        timeoutMs: 30000,
        concurrency,
      },
    };
  }

  function makeInvalidPolicy(): RuntimePolicy {
    const policy = makeValidPolicy(10);
    policy.envelope.concurrency = -5;
    return policy;
  }

  test("policy lifecycle with versions and rollback", async () => {
    const store = new PostgresPolicyStore(pool);
    const policyKey = `test-policy-${randomUUID()}`;
    const creatorId = `user-${randomUUID()}`;
    const validatorId = `validator-${randomUUID()}`;
    const approverId = `approver-${randomUUID()}`;
    const activatorId = `activator-${randomUUID()}`;
    const now1 = new Date("2024-01-01T00:00:00Z");
    const now2 = new Date("2024-01-02T00:00:00Z");
    const now3 = new Date("2024-01-03T00:00:00Z");
    const now4 = new Date("2024-01-04T00:00:00Z");

    // Version 1
    const v1 = await store.createDraft(
      policyKey,
      makeValidPolicy(10),
      creatorId,
      now1,
    );
    assert.equal(v1.version, 1);
    assert.equal(v1.state, "draft");

    // CONTRACT-015 M4: validate() now refuses a draft with no passing canary
    // record bound to its content, so the live pre-flight is a gate rather
    // than something an operator has to remember.
    await store.recordCanaryEvidence(v1.id, 1, "policy-canary", now1, [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        ok: true,
        detail: "round-trip ok",
      },
      {
        provider: "claude",
        requestedModelId: "claude-sonnet-5",
        ok: true,
        detail: "round-trip ok",
      },
    ]);

    const validated1 = await store.validate(v1.id, 1, validatorId, now1);
    assert.equal(validated1.state, "validated");

    const approved1 = await store.approve(v1.id, 1, approverId, now1);
    assert.equal(approved1.state, "approved");

    const active1 = await store.activate(v1.id, 1, activatorId, now1);
    assert.equal(active1.state, "active");
    assert.equal(active1.activatedAt?.toISOString(), now1.toISOString());

    // After activation, validate again should fail
    await assert.rejects(
      store.validate(v1.id, 1, validatorId, now4),
      /Validation fencing violated|validation fencing/i,
    );

    // Version 2
    const v2 = await store.createDraft(
      policyKey,
      makeValidPolicy(20),
      creatorId,
      now2,
    );
    assert.equal(v2.version, 2);
    assert.equal(v2.state, "draft");

    await store.recordCanaryEvidence(v2.id, 2, "policy-canary", now2, [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        ok: true,
        detail: "round-trip ok",
      },
    ]);
    await store.validate(v2.id, 2, validatorId, now2);
    await store.approve(v2.id, 2, approverId, now2);
    const active2 = await store.activate(v2.id, 2, activatorId, now2);

    assert.equal(active2.state, "active");
    assert.equal(active2.activatedAt?.toISOString(), now2.toISOString());

    const result = await pool.query(
      `SELECT event_type, policy_version FROM policy_events
         WHERE policy_key = $1 ORDER BY occurred_at`,
      [policyKey],
    );
    const events = result.rows as Array<{
      event_type: string;
      policy_version: number;
    }>;
    assert.ok(
      events.some(
        (e) => e.event_type === "activated" && e.policy_version === 1,
      ),
    );
    assert.ok(
      events.some(
        (e) => e.event_type === "superseded" && e.policy_version === 1,
      ),
    );
    assert.ok(
      events.some(
        (e) => e.event_type === "activated" && e.policy_version === 2,
      ),
    );

    const rows = await pool.query(
      `SELECT id, state FROM orchestration_policies
         WHERE policy_key = $1 ORDER BY version`,
      [policyKey],
    );
    const policyRows = rows.rows as Array<{ id: string; state: string }>;
    assert.equal(policyRows.length, 2);
    assert.equal(policyRows[0]!.state, "superseded");
    assert.equal(policyRows[1]!.state, "active");

    // Rollback to v1
    const rollbackResult = await store.rollback(
      policyKey,
      1,
      activatorId,
      now3,
    );
    assert.equal(rollbackResult.version, 3);
    assert.equal(rollbackResult.state, "active");
    assert.equal(
      (rollbackResult.policy as RuntimePolicy).envelope.concurrency,
      10,
    );
    assert.equal(rollbackResult.activatedAt?.toISOString(), now3.toISOString());

    const activeRows = await pool.query(
      `SELECT version FROM orchestration_policies
         WHERE policy_key = $1 AND state = 'active'`,
      [policyKey],
    );
    assert.equal(activeRows.rows.length, 1);
    assert.equal((activeRows.rows[0] as { version: number }).version, 3);

    const supersededRows = await pool.query(
      `SELECT version FROM orchestration_policies
         WHERE policy_key = $1 AND state = 'superseded' ORDER BY version`,
      [policyKey],
    );
    assert.deepEqual(
      (supersededRows.rows as Array<{ version: number }>).map((r) => r.version),
      [1, 2],
    );

    // Event immutability check
    await assert.rejects(
      pool.query(
        `UPDATE policy_events SET actor_id = 'hacker' WHERE policy_key = $1`,
        [policyKey],
      ),
      /cannot be modified|immutable|read.only|permission denied/i,
    );
  });

  test("invalid policy validation rejects and stays draft", async () => {
    const store = new PostgresPolicyStore(pool);
    const policyKey = `test-invalid-${randomUUID()}`;
    const creatorId = `user-${randomUUID()}`;
    const validatorId = `validator-${randomUUID()}`;
    const now = new Date();

    const draft = await store.createDraft(
      policyKey,
      makeInvalidPolicy(),
      creatorId,
      now,
    );
    assert.equal(draft.state, "draft");

    await assert.rejects(
      store.validate(draft.id, draft.version, validatorId, now),
      /validation failed|concurrency cannot be negative/i,
    );

    const rows = await pool.query(
      `SELECT state FROM orchestration_policies WHERE id = $1`,
      [draft.id],
    );
    assert.equal((rows.rows[0] as { state: string }).state, "draft");
  });

  test("validation fails closed without passing canary evidence", async () => {
    const store = new PostgresPolicyStore(pool);
    const policyKey = `test-policy-${randomUUID()}`;
    const creatorId = `user-${randomUUID()}`;
    const validatorId = `validator-${randomUUID()}`;
    const now = new Date();

    const draft = await store.createDraft(
      policyKey,
      makeValidPolicy(10),
      creatorId,
      now,
    );

    // Structurally valid, so this is not the structural validator refusing --
    // it is the missing live-canary record.
    await assert.rejects(
      store.validate(draft.id, draft.version, validatorId, now),
      /requires a passing canary/i,
    );
    const stillDraft = await pool.query(
      `SELECT state FROM orchestration_policies WHERE id = $1`,
      [draft.id],
    );
    assert.equal((stillDraft.rows[0] as { state: string }).state, "draft");

    // A canary that proves nothing is refused rather than recorded.
    await assert.rejects(
      store.recordCanaryEvidence(draft.id, draft.version, "canary", now, []),
      /at least one route result/i,
    );
    // A partial pass cannot be laundered into evidence either.
    await assert.rejects(
      store.recordCanaryEvidence(draft.id, draft.version, "canary", now, [
        {
          provider: "deepseek",
          requestedModelId: "deepseek-v4-flash",
          ok: true,
          detail: "round-trip ok",
        },
        {
          provider: "claude",
          requestedModelId: "claude-sonnet-5",
          ok: false,
          detail: "envelope parse failed",
        },
      ]),
      /1 of 2 routes failed/i,
    );

    // Still refused, because neither attempt wrote anything.
    await assert.rejects(
      store.validate(draft.id, draft.version, validatorId, now),
      /requires a passing canary/i,
    );

    await store.recordCanaryEvidence(draft.id, draft.version, "canary", now, [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        ok: true,
        detail: "round-trip ok",
      },
    ]);
    const validated = await store.validate(
      draft.id,
      draft.version,
      validatorId,
      now,
    );
    assert.equal(validated.state, "validated");
  });

  test("canary evidence does not carry across policy contents", async () => {
    const store = new PostgresPolicyStore(pool);
    const creatorId = `user-${randomUUID()}`;
    const validatorId = `validator-${randomUUID()}`;
    const now = new Date();

    // Two drafts under the same key with different content. Evidence recorded
    // against the first must not admit the second: validate() matches on
    // policy_sha256 precisely so a draft edited after its canary ran cannot
    // inherit the old proof.
    const keyA = `test-policy-${randomUUID()}`;
    const first = await store.createDraft(
      keyA,
      makeValidPolicy(10),
      creatorId,
      now,
    );
    await store.recordCanaryEvidence(first.id, first.version, "canary", now, [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        ok: true,
        detail: "round-trip ok",
      },
    ]);
    await store.validate(first.id, first.version, validatorId, now);

    const keyB = `test-policy-${randomUUID()}`;
    const other = await store.createDraft(
      keyB,
      makeValidPolicy(20),
      creatorId,
      now,
    );
    await assert.rejects(
      store.validate(other.id, other.version, validatorId, now),
      /requires a passing canary/i,
    );
  });

  after(() => pool.end());
}
