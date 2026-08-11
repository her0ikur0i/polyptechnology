import type { Pool } from "pg";

// The read model behind the closed command set.
//
// Separate from the handler so the handler can be tested without a database and
// so every query the owner can trigger from a chat lives in one file. Read-only
// by construction: there is no method here that changes anything, which is the
// property the command set is supposed to have.

export interface RunLine {
  taskId: string;
  state: string;
  driver?: string;
  // What the work is about, for a headline a person can read. Optional: some
  // drivers genuinely have no subject.
  subject?: string;
  attemptCount: number;
  maxAttempts: number;
  leasedBy?: string;
  spentUsdMicros: number;
}

export interface ApprovalLine {
  id: string;
  summary: string;
  risk: string;
  targetKind: string;
  expiresAt: Date;
}

export interface BudgetAccountLine {
  scopeId: string;
  spentUsdMicros: number;
  reservedUsdMicros: number;
  limitUsdMicros: number;
}

export interface StatusFacts {
  states: ReadonlyArray<{ state: string; count: number }>;
  pendingApprovals: number;
  budget?: BudgetAccountLine;
  lastFinishedAt?: Date;
}

export interface CommandFacts {
  status(): Promise<StatusFacts>;
  activeRuns(limit: number): Promise<ReadonlyArray<RunLine>>;
  pendingApprovals(limit: number): Promise<ReadonlyArray<ApprovalLine>>;
  budget(): Promise<ReadonlyArray<BudgetAccountLine>>;
}

// The states that mean "the factory is doing something right now". `queued` is
// included: from the owner's side, work that has been accepted and not yet
// started is still work in flight, and omitting it makes a busy factory look
// idle between leases.
export const ACTIVE_STATES = [
  "queued",
  "leased",
  "running",
  "verifying",
  "retry_wait",
  "needs_approval",
  "budget_blocked",
] as const;

export class PostgresCommandFacts implements CommandFacts {
  constructor(private readonly pool: Pool) {}

  async status(): Promise<StatusFacts> {
    const states = await this.pool.query(
      `SELECT state, count(*)::int AS count
         FROM tasks
        WHERE state = ANY($1::text[])
        GROUP BY state
        ORDER BY count DESC, state`,
      [ACTIVE_STATES],
    );

    const approvals = await this.pool.query(
      // Expiry is checked here rather than trusting `status`: an approval whose
      // window has closed is not something the owner can still answer, and
      // counting it as pending would send them looking for a button that no
      // longer works.
      `SELECT count(*)::int AS count
         FROM approval_requests
        WHERE status = 'pending' AND expires_at > now()`,
    );

    const finished = await this.pool.query(
      `SELECT max(finalized_at) AS last FROM ai_gateway_attempts`,
    );

    const accounts = await this.budget();

    const last = (finished.rows[0] as { last: Date | null } | undefined)?.last;
    return {
      states: states.rows as ReadonlyArray<{ state: string; count: number }>,
      pendingApprovals:
        (approvals.rows[0] as { count: number } | undefined)?.count ?? 0,
      // The largest account by limit stands in for "the budget" on the status
      // line. /budget shows every account; a status summary that listed all of
      // them would stop being a summary.
      ...(accounts[0] === undefined ? {} : { budget: accounts[0] }),
      ...(last === null || last === undefined ? {} : { lastFinishedAt: last }),
    };
  }

  async activeRuns(limit: number): Promise<ReadonlyArray<RunLine>> {
    // The subject joins exist so /runs can name work the way a person would:
    // the owner's own question for a chat reply, the project name for a
    // generation. The uuid casts are guarded by a shape test, because
    // `input` is jsonb written by several drivers and one malformed value
    // would otherwise fail the whole command with a cast error rather than
    // just missing a label.
    const result = await this.pool.query(
      `SELECT t.id, t.state, t.attempt_count, t.max_attempts, t.spent_usd_micros,
              s.driver, l.worker_id, q.content AS asked, g.display_name AS project_name
         FROM tasks t
         LEFT JOIN operation_task_specs s ON s.task_id = t.id
         LEFT JOIN task_leases l ON l.task_id = t.id AND l.expires_at > now()
         LEFT JOIN LATERAL (
           SELECT m.content FROM conversation_messages m
            WHERE m.conversation_id = CASE
                    WHEN s.input->>'conversationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (s.input->>'conversationId')::uuid END
              AND m.role = 'owner'
            ORDER BY m.ordinal DESC LIMIT 1
         ) q ON true
         LEFT JOIN generated_projects g ON g.id = CASE
                   WHEN s.input->>'projectId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN (s.input->>'projectId')::uuid END
        WHERE t.state = ANY($1::text[])
        ORDER BY t.state, t.id
        LIMIT $2`,
      [ACTIVE_STATES, limit],
    );
    return (
      result.rows as ReadonlyArray<{
        id: string;
        state: string;
        attempt_count: number;
        max_attempts: number;
        spent_usd_micros: string;
        driver: string | null;
        worker_id: string | null;
        asked: string | null;
        project_name: string | null;
      }>
    ).map((row) => ({
      taskId: row.id,
      state: row.state,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      spentUsdMicros: Number(row.spent_usd_micros),
      ...(row.driver === null ? {} : { driver: row.driver }),
      ...(row.worker_id === null ? {} : { leasedBy: row.worker_id }),
      // The question wins over the project name: for a chat reply both may be
      // present, and the owner recognises their own sentence faster.
      ...(row.asked !== null
        ? { subject: row.asked }
        : row.project_name !== null
          ? { subject: row.project_name }
          : {}),
    }));
  }

  async pendingApprovals(limit: number): Promise<ReadonlyArray<ApprovalLine>> {
    const result = await this.pool.query(
      `SELECT id, summary, risk, target_kind, expires_at
         FROM approval_requests
        WHERE status = 'pending' AND expires_at > now()
        ORDER BY expires_at
        LIMIT $1`,
      [limit],
    );
    return (
      result.rows as ReadonlyArray<{
        id: string;
        summary: string;
        risk: string;
        target_kind: string;
        expires_at: Date;
      }>
    ).map((row) => ({
      id: row.id,
      summary: row.summary,
      risk: row.risk,
      targetKind: row.target_kind,
      expiresAt: row.expires_at,
    }));
  }

  async budget(): Promise<ReadonlyArray<BudgetAccountLine>> {
    const result = await this.pool.query(
      `SELECT scope_id, spent_usd_micros, reserved_usd_micros, max_cost_usd_micros
         FROM ai_budget_accounts
        ORDER BY max_cost_usd_micros DESC, scope_id`,
    );
    return (
      result.rows as ReadonlyArray<{
        scope_id: string;
        spent_usd_micros: string;
        reserved_usd_micros: string;
        max_cost_usd_micros: string;
      }>
    ).map((row) => ({
      scopeId: row.scope_id,
      spentUsdMicros: Number(row.spent_usd_micros),
      reservedUsdMicros: Number(row.reserved_usd_micros),
      limitUsdMicros: Number(row.max_cost_usd_micros),
    }));
  }
}
