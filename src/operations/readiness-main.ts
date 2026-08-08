import pg from "pg";
import { databaseReadiness } from "./readiness.js";
import { structuredEvent } from "./telemetry.js";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  const result = await databaseReadiness(pool);
  console.log(
    structuredEvent(
      "service.readiness",
      result.state === "ready" ? "info" : "error",
      result,
    ),
  );
  if (result.state !== "ready") process.exitCode = 1;
} finally {
  await pool.end();
}
