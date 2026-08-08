import pg from "pg";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL,
    id = process.argv[2],
    reason = process.argv[3],
    evidenceSha256 = process.argv[4];
  if (
    databaseUrl === undefined ||
    id === undefined ||
    reason === undefined ||
    evidenceSha256 === undefined
  )
    throw new Error(
      "database, attempt id, reason, and evidence SHA are required",
    );
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const attempt = await new PostgresAttemptLedger(
      pool,
    ).reconcileUnknownAsFailed(id, reason, evidenceSha256);
    console.log(
      JSON.stringify({
        attemptId: attempt.id,
        outcome: attempt.outcome,
        failureCode: attempt.failureCode,
      }),
    );
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "reconciliation failed",
  );
  process.exitCode = 1;
});
