import pg from "pg";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL,
    attemptId = process.argv[2],
    verifier = process.argv[3],
    evidenceSha256 = process.argv[4];
  if (!databaseUrl || !attemptId || !verifier || !evidenceSha256)
    throw new Error("verification input required");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const verification = await new PostgresAttemptLedger(
      pool,
    ).recordVerification(attemptId, true, verifier, evidenceSha256);
    console.log(JSON.stringify(verification));
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "verification failed");
  process.exitCode = 1;
});
