import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresSequenceStore } from "./postgres-sequence-store.js";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
import {
  DeterministicSha256Driver,
  ExecutableTaskSupervisor,
  digest,
} from "../operations/execution-supervisor.js";
import type { OperationDriver } from "../operations/execution-supervisor.js";
import { AiPatchExecutorDriver } from "../operations/ai-patch-driver.js";
import { AiPatchOperationDriver } from "../operations/ai-patch-operation-driver.js";
import { GitPatchApplier } from "../operations/git-patch-applier.js";
import { GitIgnoringWorkspaceCopier } from "../operations/workspace-copy.js";
import { PostgresProviderArtifactStore } from "../operations/provider-artifact-store.js";
import { AiGateway } from "../gateway/gateway.js";
import { PostgresAttemptLedger } from "../gateway/postgres-ledger.js";
import { DeepSeekAdapter } from "../gateway/deepseek-adapter.js";
import { CodexCliAdapter, ClaudeCliAdapter } from "../gateway/cli-adapters.js";
import { FileSecretResolver } from "../gateway/file-secret-resolver.js";
import { SpawnWorkerRunner } from "../worker/spawn-runner.js";
const databaseUrl = process.env.DATABASE_URL,
  workerId = process.env.SEQUENCE_WORKER_ID ?? `${hostname()}:${process.pid}`;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const ttlMs = 30_000,
  pool = new pg.Pool({ connectionString: databaseUrl, max: 6 }),
  sequence = new PostgresSequenceStore(pool),
  work = new PostgresWorkRepository(pool),
  aiGateway = new AiGateway(new PostgresAttemptLedger(pool), [
    new DeepSeekAdapter(
      process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      "secret://polyp/deepseek/api-key",
      new FileSecretResolver("/root/.config/polyp/provider-secrets.env"),
    ),
    new CodexCliAdapter(),
    new ClaudeCliAdapter(),
  ]),
  aiPatchDriver = new AiPatchOperationDriver(
    new AiPatchExecutorDriver(
      aiGateway,
      new GitPatchApplier(),
      new SpawnWorkerRunner(),
      new PostgresProviderArtifactStore(pool),
      new GitIgnoringWorkspaceCopier(),
    ),
  ),
  operation = new ExecutableTaskSupervisor(
    pool,
    work,
    new Map<string, OperationDriver>([
      ["deterministic_sha256", new DeterministicSha256Driver()],
      ["ai_patch_executor", aiPatchDriver],
    ]),
    workerId,
    ttlMs,
  ),
  operationSignal = new AbortController();
let stopping = false,
  lease: Awaited<ReturnType<PostgresSequenceStore["claim"]>> | undefined,
  wake: (() => void) | undefined,
  sequenceHeartbeat: NodeJS.Timeout | undefined,
  heartbeatFailure: unknown;
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
  operationSignal.abort(new Error("supervisor stopping"));
  if (sequenceHeartbeat) clearInterval(sequenceHeartbeat);
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
  sequenceHeartbeat = setInterval(
    () => {
      if (!lease) return;
      void sequence
        .heartbeat(lease, ttlMs)
        .then((renewed) => {
          lease = renewed;
          notify("WATCHDOG=1");
        })
        .catch((error: unknown) => {
          heartbeatFailure = error;
          operationSignal.abort(error);
          wake?.();
        });
    },
    Math.floor(ttlMs / 3),
  );
  sequenceHeartbeat.unref();
  notify("--ready");
  while (!stopping) {
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    await work.reclaimExpired();
    const result = await operation.runOne(operationSignal.signal);
    if (result && lease) {
      const summaryId = randomUUID(),
        summary = result.summary;
      await pool.query(
        "INSERT INTO sequence_summaries(id,contract_id,milestone_id,summary,summary_sha256) VALUES($1,$2,$3,$4,$5)",
        [
          summaryId,
          result.task.contractId,
          result.task.milestoneId,
          summary,
          digest(summary),
        ],
      );
      await sequence.operationCheckpoint(lease, {
        taskId: result.task.id,
        attemptOrdinal: result.task.attemptCount,
        state: result.task.state,
        summaryId,
      });
      continue;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
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
