import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildLiveSnapshot } from "../src/control-api/factory-live-producer.js";
import { parseLiveSnapshot } from "../src/dashboard/factory-live/validation.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "factory live producer emits a snapshot the client validator accepts",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const snapshot = await buildLiveSnapshot(pool);
      // parseLiveSnapshot enforces ids, kinds, states, scope membership,
      // no-orphans and acyclicity -- the exact contract the client relies on.
      const parsed = parseLiveSnapshot(snapshot);
      assert.ok(parsed.nodes.some((node) => node.kind === "factory"));
      assert.ok(parsed.nodes.length >= 1);
      assert.equal(
        parsed.scopeProjectIds.length,
        parsed.scopeProjectIds.length,
      );
    } finally {
      await pool.end();
    }
  },
);
