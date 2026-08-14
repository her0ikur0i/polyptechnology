import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildSystemSnapshot } from "../src/control-api/system-snapshot.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "system snapshot reports host, process, database and budget telemetry",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const snapshot = await buildSystemSnapshot(pool);

      assert.ok(snapshot.host.uptimeSeconds >= 0);
      assert.equal(snapshot.host.loadavg.length, 3);
      assert.ok(snapshot.host.totalMemBytes > 0);
      assert.ok(snapshot.host.cpuCount >= 1);
      assert.ok(snapshot.host.platform.length > 0);

      assert.ok(snapshot.process.pid > 0);
      assert.match(snapshot.process.nodeVersion, /^v\d+/);
      assert.ok(snapshot.process.rssBytes > 0);

      assert.ok(snapshot.database.connectionCount >= 1);
      assert.ok(snapshot.database.sizeBytes > 0);
      assert.ok(snapshot.database.attemptCount >= 0);
      assert.equal(typeof snapshot.database.tasksByState, "object");

      assert.ok(Array.isArray(snapshot.budget));
      for (const scope of snapshot.budget) {
        assert.ok(scope.scopeId.length > 0);
        assert.ok(scope.maxCostUsdMicros >= 0);
        assert.ok(scope.spentUsdMicros >= 0);
      }

      assert.ok(Number.isFinite(Date.parse(snapshot.collectedAt)));
    } finally {
      await pool.end();
    }
  },
);
