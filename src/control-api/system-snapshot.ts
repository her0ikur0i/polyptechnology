import os from "node:os";
import type { Pool } from "pg";

// Live host/database/budget telemetry for the System page. Everything here is
// collected from inside the control-api's own sandbox -- the `os` module for
// the host the process can see, and `pg` for the database it owns. Deliberately
// no `systemctl`/`docker` calls: the unit's hardening profile (no new
// privileges, restricted address families) cannot reach systemd or the Docker
// socket, so a "system monitor" that claimed to would be lying.

export interface SystemSnapshot {
  host: {
    uptimeSeconds: number;
    loadavg: number[];
    totalMemBytes: number;
    freeMemBytes: number;
    cpuCount: number;
    platform: string;
    arch: string;
  };
  process: {
    pid: number;
    nodeVersion: string;
    rssBytes: number;
  };
  database: {
    connectionCount: number;
    sizeBytes: number;
    tasksByState: Record<string, number>;
    attemptCount: number;
  };
  budget: Array<{
    scopeId: string;
    spentUsdMicros: number;
    reservedUsdMicros: number;
    maxCostUsdMicros: number;
  }>;
  collectedAt: string;
}

export async function buildSystemSnapshot(pool: Pool): Promise<SystemSnapshot> {
  const [connections, dbSize, tasks, attempts, budget] = await Promise.all([
    pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity",
    ),
    pool.query<{ size: string }>(
      "SELECT pg_database_size(current_database())::text AS size",
    ),
    pool.query<{ state: string; count: string }>(
      "SELECT state, count(*)::text AS count FROM tasks GROUP BY state",
    ),
    pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ai_gateway_attempts",
    ),
    pool.query<{
      scope_id: string;
      spent_usd_micros: string;
      reserved_usd_micros: string;
      max_cost_usd_micros: string;
    }>(
      `SELECT scope_id, spent_usd_micros::text, reserved_usd_micros::text,
              max_cost_usd_micros::text
         FROM ai_budget_accounts ORDER BY scope_id`,
    ),
  ]);

  return {
    host: {
      uptimeSeconds: Math.round(os.uptime()),
      loadavg: os.loadavg(),
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      cpuCount: os.cpus().length,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
    },
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      rssBytes: process.memoryUsage().rss,
    },
    database: {
      connectionCount: Number(connections.rows[0]?.count ?? 0),
      sizeBytes: Number(dbSize.rows[0]?.size ?? 0),
      tasksByState: Object.fromEntries(
        tasks.rows.map((row) => [row.state, Number(row.count)]),
      ),
      attemptCount: Number(attempts.rows[0]?.count ?? 0),
    },
    budget: budget.rows.map((row) => ({
      scopeId: row.scope_id,
      spentUsdMicros: Number(row.spent_usd_micros),
      reservedUsdMicros: Number(row.reserved_usd_micros),
      maxCostUsdMicros: Number(row.max_cost_usd_micros),
    })),
    collectedAt: new Date().toISOString(),
  };
}
