import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  ensureManagedBudgetAccount,
  MANAGED_DEEPSEEK_BUDGET_USD_MICROS,
} from "../scripts/managed-deepseek-task.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "managed DeepSeek task bootstraps a budget row without overwriting spend",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const scopeId = `managed-deepseek-${randomUUID()}`;
    try {
      await ensureManagedBudgetAccount(pool, scopeId);
      let result = await pool.query<{
        max_cost_usd_micros: string;
        spent_usd_micros: string;
        reserved_usd_micros: string;
      }>(
        "SELECT max_cost_usd_micros, spent_usd_micros, reserved_usd_micros FROM ai_budget_accounts WHERE scope_id=$1",
        [scopeId],
      );
      assert.deepEqual(result.rows[0], {
        max_cost_usd_micros: String(MANAGED_DEEPSEEK_BUDGET_USD_MICROS),
        spent_usd_micros: "0",
        reserved_usd_micros: "0",
      });

      await pool.query(
        "UPDATE ai_budget_accounts SET spent_usd_micros=7, reserved_usd_micros=11 WHERE scope_id=$1",
        [scopeId],
      );
      await ensureManagedBudgetAccount(pool, scopeId, 9_999_999);
      result = await pool.query(
        "SELECT max_cost_usd_micros, spent_usd_micros, reserved_usd_micros FROM ai_budget_accounts WHERE scope_id=$1",
        [scopeId],
      );
      assert.deepEqual(result.rows[0], {
        max_cost_usd_micros: String(MANAGED_DEEPSEEK_BUDGET_USD_MICROS),
        spent_usd_micros: "7",
        reserved_usd_micros: "11",
      });
    } finally {
      await pool.query("DELETE FROM ai_budget_accounts WHERE scope_id=$1", [
        scopeId,
      ]);
      await pool.end();
    }
  },
);
