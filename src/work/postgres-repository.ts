import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { canTransition, controlSources, retryable } from "./state-machine.js";
import type { FailureReason, Lease, Task, TaskState } from "./types.js";
type TaskRow = {
  id: string;
  contract_id: string;
  milestone_id: string;
  idempotency_key: string;
  state: TaskState;
  max_cost_usd_micros: string;
  spent_usd_micros: string;
  attempt_count: number;
  max_attempts: number;
};
const task = (r: TaskRow): Task => ({
  id: r.id,
  contractId: r.contract_id,
  milestoneId: r.milestone_id,
  idempotencyKey: r.idempotency_key,
  state: r.state,
  maxCostUsdMicros: Number(r.max_cost_usd_micros),
  spentUsdMicros: Number(r.spent_usd_micros),
  attemptCount: r.attempt_count,
  maxAttempts: r.max_attempts,
});
export class PostgresWorkRepository {
  constructor(private readonly pool: Pool) {}
  async submit(
    input: Omit<Task, "id" | "state" | "spentUsdMicros" | "attemptCount">,
  ): Promise<Task> {
    const result = await this.pool.query<TaskRow>(
      "INSERT INTO tasks(id,contract_id,milestone_id,idempotency_key,state,max_cost_usd_micros,max_attempts) VALUES($1,$2,$3,$4,'draft',$5,$6) ON CONFLICT(contract_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *",
      [
        randomUUID(),
        input.contractId,
        input.milestoneId,
        input.idempotencyKey,
        input.maxCostUsdMicros,
        input.maxAttempts,
      ],
    );
    return task(result.rows[0]!);
  }
  async controlTransition(
    taskId: string,
    from: TaskState,
    to: TaskState,
  ): Promise<Task> {
    if (!controlSources.has(from) || !canTransition(from, to))
      throw new Error("invalid control transition");
    const result = await this.pool.query<TaskRow>(
      "UPDATE tasks SET state=$3,next_attempt_at=NULL WHERE id=$1 AND state=$2 AND ($2<>'retry_wait' OR next_attempt_at<=CURRENT_TIMESTAMP) RETURNING *",
      [taskId, from, to],
    );
    if (result.rowCount !== 1)
      throw new Error("invalid task state or retry backoff active");
    return task(result.rows[0]!);
  }
  async lease(taskId: string, workerId: string, ttlMs: number): Promise<Lease> {
    this.validTtl(ttlMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "WITH expired AS (DELETE FROM task_leases WHERE task_id=$1 AND expires_at<=CURRENT_TIMESTAMP RETURNING task_id) UPDATE tasks SET state='queued' FROM expired WHERE tasks.id=expired.task_id AND tasks.state IN ('leased','running','verifying')",
        [taskId],
      );
      await client.query(
        "UPDATE tasks SET state='failed' WHERE id=$1 AND state='queued' AND attempt_count>=max_attempts",
        [taskId],
      );
      await client.query(
        "UPDATE tasks t SET state='budget_blocked' FROM factory_contracts c WHERE t.id=$1 AND t.contract_id=c.id AND t.state='queued' AND (t.spent_usd_micros>=t.max_cost_usd_micros OR c.spent_usd_micros>=c.max_cost_usd_micros)",
        [taskId],
      );
      const result = await client.query<{
        fencing_token: string;
        heartbeat_at: Date;
        expires_at: Date;
      }>(
        "WITH candidate AS (SELECT t.id FROM tasks t JOIN factory_contracts c ON c.id=t.contract_id CROSS JOIN factory_controls f WHERE t.id=$1 AND t.state='queued' AND NOT f.emergency_stopped FOR UPDATE OF t,c FOR SHARE OF f), changed AS (UPDATE tasks SET state='leased',attempt_count=attempt_count+1 FROM candidate WHERE tasks.id=candidate.id RETURNING tasks.id) INSERT INTO task_leases(task_id,worker_id,heartbeat_at,expires_at) SELECT id,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+($3*interval '1 millisecond') FROM changed RETURNING fencing_token,heartbeat_at,expires_at",
        [taskId, workerId, ttlMs],
      );
      if (result.rowCount !== 1) throw new Error("task cannot be leased");
      const attempt = await client.query<{ attempt_count: number }>(
        "SELECT attempt_count FROM tasks WHERE id=$1",
        [taskId],
      );
      const ordinal = attempt.rows[0]!.attempt_count;
      await client.query(
        "INSERT INTO task_attempts(id,task_id,ordinal,state,started_at) VALUES($1,$2,$3,'leased',CURRENT_TIMESTAMP)",
        [randomUUID(), taskId, ordinal],
      );
      await client.query("COMMIT");
      const row = result.rows[0]!;
      return {
        taskId,
        workerId,
        fencingToken: Number(row.fencing_token),
        attemptOrdinal: ordinal,
        heartbeatAt: row.heartbeat_at,
        expiresAt: row.expires_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async heartbeat(
    taskId: string,
    fencingToken: number,
    ttlMs: number,
  ): Promise<Lease> {
    this.validTtl(ttlMs);
    const result = await this.pool.query<{
      worker_id: string;
      fencing_token: string;
      heartbeat_at: Date;
      expires_at: Date;
      attempt_ordinal: number;
    }>(
      "WITH updated AS (UPDATE task_leases SET heartbeat_at=CURRENT_TIMESTAMP,expires_at=CURRENT_TIMESTAMP+($3*interval '1 millisecond') WHERE task_id=$1 AND fencing_token=$2 AND expires_at>CURRENT_TIMESTAMP AND NOT (SELECT emergency_stopped FROM factory_controls WHERE singleton) RETURNING *) SELECT u.worker_id,u.fencing_token,u.heartbeat_at,u.expires_at,t.attempt_count AS attempt_ordinal FROM updated u JOIN tasks t ON t.id=u.task_id",
      [taskId, fencingToken, ttlMs],
    );
    if (result.rowCount !== 1) throw new Error("stale lease or emergency stop");
    const row = result.rows[0]!;
    return {
      taskId,
      workerId: row.worker_id,
      fencingToken: Number(row.fencing_token),
      attemptOrdinal: row.attempt_ordinal,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    };
  }
  async transition(
    taskId: string,
    fencingToken: number,
    from: TaskState,
    to: TaskState,
  ): Promise<Task> {
    if (
      !canTransition(from, to) ||
      !new Set<TaskState>(["leased", "running", "verifying"]).has(from)
    )
      throw new Error("invalid worker transition");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>(
        "UPDATE tasks SET state=$4 FROM task_leases l WHERE tasks.id=$1 AND tasks.state=$3 AND l.task_id=tasks.id AND l.fencing_token=$2 AND l.expires_at>CURRENT_TIMESTAMP RETURNING tasks.*",
        [taskId, fencingToken, from, to],
      );
      if (result.rowCount !== 1)
        throw new Error("stale lease or invalid task state");
      const ordinal = result.rows[0]!.attempt_count;
      await client.query(
        "UPDATE task_attempts SET state=$3,finished_at=CASE WHEN $3 IN ('succeeded','failed','cancelled','retry_wait') THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE task_id=$1 AND ordinal=$2",
        [taskId, ordinal, to],
      );
      if (!new Set<TaskState>(["leased", "running", "verifying"]).has(to))
        await client.query(
          "DELETE FROM task_leases WHERE task_id=$1 AND fencing_token=$2",
          [taskId, fencingToken],
        );
      await client.query("COMMIT");
      return task(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async fail(
    taskId: string,
    fencingToken: number,
    reason: FailureReason,
    retryAfterMs: number,
  ): Promise<Task> {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
      throw new Error("invalid retry delay");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<TaskRow>(
        "SELECT t.* FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE t.id=$1 AND l.fencing_token=$2 AND l.expires_at>CURRENT_TIMESTAMP AND t.state IN ('running','verifying') FOR UPDATE OF t",
        [taskId, fencingToken],
      );
      if (current.rowCount !== 1)
        throw new Error("stale lease or invalid task state");
      const row = current.rows[0]!,
        next: TaskState = !retryable(reason)
          ? reason === "budget"
            ? "budget_blocked"
            : "failed"
          : row.attempt_count >= row.max_attempts
            ? "failed"
            : "retry_wait";
      const changed = await client.query<TaskRow>(
        "UPDATE tasks SET state=$2,next_attempt_at=CASE WHEN $2='retry_wait' THEN CURRENT_TIMESTAMP+($3*interval '1 millisecond') ELSE NULL END WHERE id=$1 RETURNING *",
        [taskId, next, retryAfterMs],
      );
      await client.query(
        "UPDATE task_attempts SET state=$3,failure_reason=$4,finished_at=CURRENT_TIMESTAMP WHERE task_id=$1 AND ordinal=$2",
        [taskId, row.attempt_count, next, reason],
      );
      await client.query(
        "DELETE FROM task_leases WHERE task_id=$1 AND fencing_token=$2",
        [taskId, fencingToken],
      );
      await client.query("COMMIT");
      return task(changed.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async reclaimExpired(): Promise<ReadonlyArray<string>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{ task_id: string }>(
        "DELETE FROM task_leases WHERE expires_at<=CURRENT_TIMESTAMP RETURNING task_id",
      );
      const ids = expired.rows.map((row) => row.task_id);
      if (ids.length > 0) {
        await client.query(
          "UPDATE task_attempts a SET state='failed',failure_reason='worker',finished_at=CURRENT_TIMESTAMP FROM tasks t WHERE a.task_id=t.id AND a.ordinal=t.attempt_count AND a.task_id=ANY($1::uuid[]) AND a.finished_at IS NULL",
          [ids],
        );
        await client.query(
          "UPDATE tasks SET state=CASE WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'queued' END WHERE id=ANY($1::uuid[]) AND state IN ('leased','running','verifying')",
          [ids],
        );
      }
      await client.query("COMMIT");
      return ids;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async setEmergencyStop(stopped: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE factory_controls SET emergency_stopped=$1 WHERE singleton",
        [stopped],
      );
      if (stopped) {
        await client.query(
          "UPDATE task_attempts a SET state='cancelled',failure_reason='worker',finished_at=CURRENT_TIMESTAMP FROM tasks t WHERE a.task_id=t.id AND a.ordinal=t.attempt_count AND t.state IN ('leased','running','verifying') AND a.finished_at IS NULL",
        );
        await client.query(
          "WITH paused AS (UPDATE tasks SET state='queued' WHERE state IN ('leased','running','verifying') RETURNING id) DELETE FROM task_leases l USING paused p WHERE l.task_id=p.id",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async recordCost(
    taskId: string,
    attemptOrdinal: number,
    costId: string,
    cost: number,
  ): Promise<Task> {
    if (
      !Number.isSafeInteger(attemptOrdinal) ||
      attemptOrdinal < 1 ||
      costId.length === 0 ||
      !Number.isSafeInteger(cost) ||
      cost < 0
    )
      throw new Error("invalid cost");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO task_costs(cost_id,task_id,attempt_ordinal,amount_usd_micros,occurred_at) VALUES($3,$1,$2,$4,CURRENT_TIMESTAMP) ON CONFLICT(cost_id) DO NOTHING RETURNING task_id",
        [taskId, attemptOrdinal, costId, cost],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          task_id: string;
          attempt_ordinal: number;
          amount_usd_micros: string;
        }>(
          "SELECT task_id,attempt_ordinal,amount_usd_micros FROM task_costs WHERE cost_id=$1 FOR SHARE",
          [costId],
        );
        const row = existing.rows[0];
        if (
          row === undefined ||
          row.task_id !== taskId ||
          row.attempt_ordinal !== attemptOrdinal ||
          Number(row.amount_usd_micros) !== cost
        )
          throw new Error("cost id collision");
      }
      if (inserted.rowCount === 1) {
        const contract = await client.query<{ contract_id: string }>(
          "UPDATE factory_contracts c SET spent_usd_micros=c.spent_usd_micros+$2 FROM tasks t WHERE t.id=$1 AND c.id=t.contract_id RETURNING c.id AS contract_id",
          [taskId, cost],
        );
        await client.query(
          "UPDATE tasks SET spent_usd_micros=spent_usd_micros+$2 WHERE id=$1",
          [taskId, cost],
        );
        const blocked = await client.query<{ id: string }>(
          "UPDATE tasks t SET state='budget_blocked' FROM factory_contracts c WHERE c.id=t.contract_id AND c.id=$1 AND (c.spent_usd_micros>=c.max_cost_usd_micros OR t.spent_usd_micros>=t.max_cost_usd_micros) AND t.state IN ('queued','leased','running','verifying','retry_wait') RETURNING t.id",
          [contract.rows[0]!.contract_id],
        );
        if (blocked.rowCount)
          await client.query(
            "DELETE FROM task_leases WHERE task_id=ANY($1::uuid[])",
            [blocked.rows.map((row) => row.id)],
          );
      }
      const result = await client.query<TaskRow>(
        "SELECT * FROM tasks WHERE id=$1",
        [taskId],
      );
      if (result.rowCount !== 1) throw new Error("unknown task or attempt");
      await client.query("COMMIT");
      return task(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private validTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new Error("lease TTL must be positive");
  }
}
