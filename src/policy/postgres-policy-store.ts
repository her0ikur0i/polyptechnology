import type { Pool, PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { validatePolicy } from "./validate-policy.js";
import type { RuntimePolicy } from "./types.js";

export interface StoredPolicy {
  id: string;
  policyKey: string;
  version: number;
  state: string;
  policy: unknown;
  policySha256: string;
  emergencyCostCeilingUsdMicros: number;
  creatorId: string;
  validatorId: string | null;
  approverId: string | null;
  activatorId: string | null;
  createdAt: Date;
  validatedAt: Date | null;
  approvedAt: Date | null;
  activatedAt: Date | null;
  supersededAt: Date | null;
}

function assertBoundedNonblank(value: string, label: string): void {
  if (!value.trim() || value.trim().length > 200) {
    throw new Error(`${label} must be bounded nonblank`);
  }
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "bigint")
    return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value))
    return `[${value.map((v) => stableSerialize(v)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(record[k])}`).join(",")}}`;
  }
  throw new Error("Unsupported value type for stable serialization");
}

function hashPolicy(policy: unknown): string {
  return createHash("sha256").update(stableSerialize(policy)).digest("hex");
}

function mapRow(row: Record<string, unknown>): StoredPolicy {
  return {
    id: row.id as string,
    policyKey: row.policy_key as string,
    version: row.version as number,
    state: row.state as string,
    policy: row.policy as unknown,
    policySha256: row.policy_sha256 as string,
    emergencyCostCeilingUsdMicros: Number(
      row.emergency_cost_ceiling_usd_micros,
    ),
    creatorId: row.creator_id as string,
    validatorId: row.validator_id as string | null,
    approverId: row.approver_id as string | null,
    activatorId: row.activator_id as string | null,
    createdAt: row.created_at as Date,
    validatedAt: row.validated_at as Date | null,
    approvedAt: row.approved_at as Date | null,
    activatedAt: row.activated_at as Date | null,
    supersededAt: row.superseded_at as Date | null,
  };
}

function extractEnvelope(policy: unknown): ExecutionEnvelopeLike {
  const p = policy as { envelope?: Record<string, unknown> };
  if (!p?.envelope || typeof p.envelope !== "object") {
    throw new Error("Policy envelope required");
  }
  const emergencyCostCeilingUsdMicros =
    p.envelope.emergencyCostCeilingUsdMicros;
  if (
    typeof emergencyCostCeilingUsdMicros !== "number" ||
    !Number.isSafeInteger(emergencyCostCeilingUsdMicros) ||
    emergencyCostCeilingUsdMicros <= 0
  )
    throw new Error(
      "emergencyCostCeilingUsdMicros must be a positive safe integer",
    );
  return { emergencyCostCeilingUsdMicros };
}

interface ExecutionEnvelopeLike {
  emergencyCostCeilingUsdMicros: number;
}

async function insertEvent(
  client: PoolClient,
  policyKey: string,
  policyVersion: number,
  eventType: string,
  actorId: string,
  occurredAt: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO policy_events (id, policy_key, policy_version, event_type, actor_id, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      policyKey,
      policyVersion,
      eventType,
      actorId,
      JSON.stringify(payload),
      occurredAt,
    ],
  );
}

async function fetchPolicy(
  client: PoolClient,
  id: string,
): Promise<StoredPolicy | null> {
  const result = await client.query(
    `SELECT id, policy_key, version, state, policy, policy_sha256, emergency_cost_ceiling_usd_micros,
            creator_id, validator_id, approver_id, activator_id, created_at, validated_at, approved_at, activated_at, superseded_at
     FROM orchestration_policies WHERE id = $1`,
    [id],
  );
  return result.rowCount === 1
    ? mapRow(result.rows[0] as Record<string, unknown>)
    : null;
}

async function fetchByKeyAndVersion(
  client: PoolClient,
  policyKey: string,
  version: number,
): Promise<StoredPolicy | null> {
  const result = await client.query(
    `SELECT id, policy_key, version, state, policy, policy_sha256, emergency_cost_ceiling_usd_micros,
            creator_id, validator_id, approver_id, activator_id, created_at, validated_at, approved_at, activated_at, superseded_at
     FROM orchestration_policies WHERE policy_key = $1 AND version = $2`,
    [policyKey, version],
  );
  return result.rowCount === 1
    ? mapRow(result.rows[0] as Record<string, unknown>)
    : null;
}

async function activateTarget(
  client: PoolClient,
  target: StoredPolicy,
  actorId: string,
  now: Date,
): Promise<void> {
  const superseded = await client.query(
    `UPDATE orchestration_policies
     SET state = 'superseded', superseded_at = $2
     WHERE policy_key = $1 AND state = 'active'
     RETURNING id, policy_key, version`,
    [target.policyKey, now],
  );

  for (const row of superseded.rows as Array<{
    id: string;
    policy_key: string;
    version: number;
  }>) {
    await insertEvent(
      client,
      row.policy_key,
      row.version,
      "superseded",
      actorId,
      now,
      {
        supersededAt: now.toISOString(),
        supersededByVersion: target.version,
      },
    );
  }

  const activated = await client.query(
    `UPDATE orchestration_policies
     SET state = 'active', activated_at = $3, activator_id = $4
     WHERE id = $1 AND state = 'approved' AND version = $2`,
    [target.id, target.version, now, actorId],
  );
  if (activated.rowCount !== 1) throw new Error("Activation fencing violated");

  await insertEvent(
    client,
    target.policyKey,
    target.version,
    "activated",
    actorId,
    now,
    {
      activatedAt: now.toISOString(),
    },
  );
}

export class PostgresPolicyStore {
  constructor(private readonly pool: Pool) {}

  async createDraft(
    policyKey: string,
    policy: unknown,
    creatorId: string,
    now: Date,
  ): Promise<StoredPolicy> {
    assertBoundedNonblank(policyKey, "policyKey");
    assertBoundedNonblank(creatorId, "creatorId");
    const envelope = extractEnvelope(policy);
    const ceiling = envelope.emergencyCostCeilingUsdMicros;
    if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
      throw new Error(
        "emergencyCostCeilingUsdMicros must be positive safe integer",
      );
    }
    const sha = hashPolicy(policy);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        policyKey,
      ]);
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM orchestration_policies WHERE policy_key = $1`,
        [policyKey],
      );
      const version = Number(
        (versionResult.rows[0] as { next_version: string }).next_version,
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO orchestration_policies
         (id, policy_key, version, state, policy, policy_sha256, emergency_cost_ceiling_usd_micros,
          creator_id, created_at)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8)`,
        [
          id,
          policyKey,
          version,
          JSON.stringify(policy),
          sha,
          ceiling,
          creatorId,
          now,
        ],
      );
      await insertEvent(
        client,
        policyKey,
        version,
        "draft_created",
        creatorId,
        now,
        {
          creatorId,
        },
      );
      await client.query("COMMIT");
      const created = await fetchByKeyAndVersion(client, policyKey, version);
      if (!created) throw new Error("Created policy not found");
      return created;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async validate(
    id: string,
    expectedVersion: number,
    validatorId: string,
    now: Date,
  ): Promise<StoredPolicy> {
    assertBoundedNonblank(validatorId, "validatorId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const policy = await fetchPolicy(client, id);
      if (!policy) throw new Error("Policy not found");
      if (policy.version !== expectedVersion)
        throw new Error("Version mismatch");

      const runtimePolicy = policy.policy as RuntimePolicy;
      const validatedErrors = validatePolicy(runtimePolicy);
      if (validatedErrors.length > 0)
        throw new Error("Policy validation failed");

      const updated = await client.query(
        `UPDATE orchestration_policies
         SET state = 'validated', validator_id = $3, validated_at = $4
         WHERE id = $1 AND version = $2 AND state = 'draft'`,
        [id, expectedVersion, validatorId, now],
      );
      if (updated.rowCount !== 1)
        throw new Error("Validation fencing violated");

      await insertEvent(
        client,
        policy.policyKey,
        policy.version,
        "validated",
        validatorId,
        now,
        {
          validatorId,
        },
      );
      await client.query("COMMIT");

      return { ...policy, state: "validated", validatorId, validatedAt: now };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async approve(
    id: string,
    expectedVersion: number,
    approverId: string,
    now: Date,
  ): Promise<StoredPolicy> {
    assertBoundedNonblank(approverId, "approverId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const policy = await fetchPolicy(client, id);
      if (!policy) throw new Error("Policy not found");
      if (policy.version !== expectedVersion)
        throw new Error("Version mismatch");

      const updated = await client.query(
        `UPDATE orchestration_policies
         SET state = 'approved', approver_id = $3, approved_at = $4
         WHERE id = $1 AND version = $2 AND state = 'validated'`,
        [id, expectedVersion, approverId, now],
      );
      if (updated.rowCount !== 1) throw new Error("Approval fencing violated");

      await insertEvent(
        client,
        policy.policyKey,
        policy.version,
        "approved",
        approverId,
        now,
        {
          approverId,
        },
      );
      await client.query("COMMIT");

      return { ...policy, state: "approved", approverId, approvedAt: now };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activate(
    id: string,
    expectedVersion: number,
    activatorId: string,
    now: Date,
  ): Promise<StoredPolicy> {
    assertBoundedNonblank(activatorId, "activatorId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const policy = await fetchPolicy(client, id);
      if (!policy) throw new Error("Policy not found");
      if (policy.version !== expectedVersion)
        throw new Error("Version mismatch");

      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        policy.policyKey,
      ]);

      const preUpdate = await client.query(
        `SELECT 1 FROM orchestration_policies
         WHERE id = $1 AND version = $2 AND state = 'approved'
         FOR UPDATE`,
        [id, expectedVersion],
      );
      if (preUpdate.rowCount !== 1)
        throw new Error("Activation fencing violated");

      await activateTarget(client, policy, activatorId, now);
      await client.query("COMMIT");

      return { ...policy, state: "active", activatorId, activatedAt: now };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(
    policyKey: string,
    targetVersion: number,
    actorId: string,
    now: Date,
  ): Promise<StoredPolicy> {
    assertBoundedNonblank(policyKey, "policyKey");
    assertBoundedNonblank(actorId, "actorId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        policyKey,
      ]);
      const target = await fetchByKeyAndVersion(
        client,
        policyKey,
        targetVersion,
      );
      if (!target || target.state !== "superseded") {
        throw new Error("Target must be superseded for rollback");
      }

      const newVersionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM orchestration_policies WHERE policy_key = $1`,
        [policyKey],
      );
      const newVersion = Number(
        (newVersionResult.rows[0] as { next_version: string }).next_version,
      );
      const newId = randomUUID();

      await client.query(
        `INSERT INTO orchestration_policies
         (id, policy_key, version, state, policy, policy_sha256, emergency_cost_ceiling_usd_micros,
          creator_id, validator_id, approver_id, activator_id, created_at, validated_at, approved_at)
         VALUES ($1, $2, $3, 'approved', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          newId,
          policyKey,
          newVersion,
          JSON.stringify(target.policy),
          target.policySha256,
          target.emergencyCostCeilingUsdMicros,
          target.creatorId,
          actorId,
          actorId,
          null,
          now,
          now,
          now,
        ],
      );

      await insertEvent(
        client,
        policyKey,
        newVersion,
        "rollback_created",
        actorId,
        now,
        {
          sourceVersion: targetVersion,
          actorId,
        },
      );

      const cloned = await fetchByKeyAndVersion(client, policyKey, newVersion);
      if (!cloned) throw new Error("Cloned policy not found");

      await activateTarget(client, cloned, actorId, now);
      await client.query("COMMIT");

      return {
        ...cloned,
        state: "active",
        activatorId: actorId,
        activatedAt: now,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async active(policyKey: string): Promise<StoredPolicy> {
    assertBoundedNonblank(policyKey, "policyKey");
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, policy_key, version, state, policy, policy_sha256, emergency_cost_ceiling_usd_micros,
                creator_id, validator_id, approver_id, activator_id, created_at, validated_at, approved_at, activated_at, superseded_at
         FROM orchestration_policies
         WHERE policy_key = $1 AND state = 'active'`,
        [policyKey],
      );
      if (result.rowCount !== 1)
        throw new Error("Active policy not found or duplicated");
      return mapRow(result.rows[0] as Record<string, unknown>);
    } finally {
      client.release();
    }
  }

  // task_role_overrides.task_id REFERENCES tasks(id) -- an override can only
  // be granted for a task that already exists, matching the contract's own
  // model: the owner is overriding one specific already-queued task, not
  // pre-authorizing hypothetical future ones.
  async insertOverride(input: {
    id: string;
    taskId: string;
    ownerId: string;
    reason: string;
    expiresAt: Date;
    occurredAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_role_overrides
       (id, task_id, owner_id, reason, codex_technical_execution, created_at, expires_at)
       VALUES ($1, $2, $3, $4, true, $5, $6)`,
      [
        input.id,
        input.taskId,
        input.ownerId,
        input.reason,
        input.occurredAt,
        input.expiresAt,
      ],
    );
  }

  async findActiveOverride(taskId: string): Promise<
    | {
        task_id: string;
        owner_id: string;
        reason: string;
        expires_at: Date;
      }
    | undefined
  > {
    const result = await this.pool.query<{
      task_id: string;
      owner_id: string;
      reason: string;
      expires_at: Date;
    }>(
      `SELECT task_id, owner_id, reason, expires_at
       FROM task_role_overrides
       WHERE task_id = $1 AND codex_technical_execution AND expires_at > CURRENT_TIMESTAMP
       ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    return result.rows[0];
  }
}
