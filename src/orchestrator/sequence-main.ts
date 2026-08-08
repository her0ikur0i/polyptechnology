import { spawn } from "node:child_process";
import { hostname } from "node:os";
import pg from "pg";
import { PostgresSequenceStore } from "./postgres-sequence-store.js";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
const databaseUrl = process.env.DATABASE_URL,
  workerId = process.env.SEQUENCE_WORKER_ID ?? `${hostname()}:${process.pid}`;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const ttlMs = 30_000,
  pool = new pg.Pool({ connectionString: databaseUrl, max: 2 }),
  sequence = new PostgresSequenceStore(pool),
  work = new PostgresWorkRepository(pool);
let stopping = false,
  lease: Awaited<ReturnType<PostgresSequenceStore["claim"]>> | undefined,
  wake: (() => void) | undefined;
function notify(argument: string) {
  if (!process.env.NOTIFY_SOCKET) return;
  const child = spawn("/usr/bin/systemd-notify", [argument], {
    stdio: "ignore",
    shell: false,
  });
  child.unref();
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  wake?.();
  try {
    if (lease) await sequence.release(lease);
  } finally {
    await pool.end();
    process.exitCode = 0;
  }
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
async function main() {
  lease = await sequence.claim(workerId, ttlMs);
  notify("--ready");
  while (!stopping) {
    await work.reclaimExpired();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.floor(ttlMs / 3));
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
    if (stopping) break;
    lease = await sequence.heartbeat(lease, ttlMs);
    notify("WATCHDOG=1");
  }
}
main().catch(async (error) => {
  console.error(
    JSON.stringify({
      event: "sequence.supervisor.failed",
      code: error instanceof Error ? error.message : "unknown",
    }),
  );
  await shutdown();
  process.exitCode = 1;
});
