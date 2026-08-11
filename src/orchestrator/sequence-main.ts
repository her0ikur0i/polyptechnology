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
import { PostgresPolicyRouteResolver } from "../operations/policy-route-resolver.js";
import { ConversationReplyDriver } from "../operations/conversation-reply-driver.js";
import { BlueprintTranslationDriver } from "../operations/blueprint-translation-driver.js";
import { PostgresConversationStore } from "./postgres-store.js";
import {
  ForgivingProviderSessionStore,
  PostgresProviderSessionStore,
} from "./provider-sessions.js";
import { PostgresProjectFactory } from "../factory/postgres-repository.js";
import { FactoryLifecycleAdvancer } from "../factory/generation-lifecycle.js";
import { PostgresPolicyStore } from "../policy/postgres-policy-store.js";
import { PROGRAMMING_POLICY_KEY } from "../policy/types.js";
import { AiGateway } from "../gateway/gateway.js";
import { PostgresAttemptLedger } from "../gateway/postgres-ledger.js";
import { DeepSeekAdapter } from "../gateway/deepseek-adapter.js";
import { CodexCliAdapter, ClaudeCliAdapter } from "../gateway/cli-adapters.js";
import { FileSecretResolver } from "../gateway/file-secret-resolver.js";
import { SpawnWorkerRunner } from "../worker/spawn-runner.js";
import { PostgresReplyChunkStore } from "./reply-chunks.js";
import {
  PostgresRunFacts,
  TelegramRunNotifier,
} from "../operations/run-notifier.js";
import { TelegramHttpTransport } from "../telegram/gateway.js";
import {
  PostgresUpdateOffsetStore,
  TelegramUpdatePoller,
} from "../telegram/poller.js";
import { TelegramApprovalUpdateHandler } from "../telegram/approval-handler.js";
import { PostgresTelegramDecisionService } from "../control-api/telegram-webhook.js";
import { PostgresApprovalRepository } from "../approvals/postgres-repository.js";
import {
  TELEGRAM_ACTOR,
  TelegramConversationHandler,
  telegramConversationKey,
} from "../telegram/conversation-handler.js";
import { CompositeUpdateHandler } from "../telegram/dispatch.js";
import {
  TelegramCommandHandler,
  TelegramCommandService,
} from "../telegram/command-handler.js";
import { PostgresCommandFacts } from "../telegram/command-facts.js";
import { deterministicUuid } from "../deterministic-id.js";
import { OwnerCommandService } from "../operations/owner-commands.js";
import { OrchestratorService } from "./service.js";
import { queueConversationReply } from "./reply-task.js";
const databaseUrl = process.env.DATABASE_URL,
  workerId = process.env.SEQUENCE_WORKER_ID ?? `${hostname()}:${process.pid}`,
  telegramBotToken = process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId = process.env.TELEGRAM_CHAT_ID,
  telegramUserId = process.env.TELEGRAM_USER_ID;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const ttlMs = 30_000,
  pool = new pg.Pool({ connectionString: databaseUrl, max: 6 }),
  // Not loadConfig(): that validates the HTTP server's settings and refuses to
  // load in production without ACCESS_AUTH_MODE, which is meaningless for a
  // process with no HTTP surface. Trying it here failed the service on startup.
  //
  // The secret is generated locally and never leaves this process. That is
  // honest rather than lax: CSRF defends a browser form post against another
  // origin, and a Telegram update is not one. OwnerCommandService requires the
  // token because it was designed for HTTP, so the check is satisfied
  // structurally; the real authorization for this path is the poller's
  // identity check plus the proposal gate that still governs execution.
  telegramCommandSecret = randomUUID() + randomUUID(),
  telegramConversations = new PostgresConversationStore(pool),
  telegramConversationId =
    telegramChatId === undefined
      ? undefined
      : // Must match what TelegramConversationHandler creates, or replies are
        // produced and never delivered. Both derive it from the same helper.
        deterministicUuid(
          `${TELEGRAM_ACTOR}:${telegramConversationKey(telegramChatId)}:conversation`,
        ),
  runNotifier =
    telegramBotToken !== undefined && telegramChatId !== undefined
      ? new TelegramRunNotifier(
          new TelegramHttpTransport(telegramBotToken),
          telegramChatId,
          new PostgresRunFacts(pool),
          telegramConversationId,
        )
      : undefined,
  sequence = new PostgresSequenceStore(pool),
  work = new PostgresWorkRepository(pool),
  aiGateway = new AiGateway(new PostgresAttemptLedger(pool), [
    new DeepSeekAdapter(
      process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      "secret://polyp/deepseek/api-key",
      // Configurable, because the hard-coded path was `/root/.config/...` and
      // this process runs as `polyp-factory` under `ProtectHome=true` -- it
      // could not read that file, and never can. The default keeps developer
      // machines working unchanged; deployments point it somewhere the service
      // user is actually allowed to read. Found by trying to run the supervisor
      // for real rather than by any test.
      new FileSecretResolver(
        process.env.PROVIDER_SECRETS_FILE ??
          "/root/.config/polyp/provider-secrets.env",
      ),
    ),
    new CodexCliAdapter(),
    new ClaudeCliAdapter(undefined, 3, undefined, {
      // Owner-authorised on 2026-08-10: the assistant reachable from Telegram
      // is meant to be genuinely capable, not a suggestion box. Both settings
      // are read from the environment so turning this off is a config change
      // and a restart, not a code change.
      ...(process.env.ASSISTANT_TOOLS === "enabled" ? { tools: true } : {}),
      ...(process.env.ASSISTANT_WORKING_DIRECTORY
        ? { workingDirectory: process.env.ASSISTANT_WORKING_DIRECTORY }
        : {}),
    }),
  ]),
  // Inbound Telegram. Built only when an authorized identity is configured:
  // without one there is nobody to authorise, and a poller that accepts
  // everything would be worse than no poller.
  telegramPoller =
    telegramBotToken !== undefined &&
    telegramChatId !== undefined &&
    telegramUserId !== undefined
      ? new TelegramUpdatePoller(
          // A longer client timeout than the 25 s long poll, or the request is
          // aborted exactly when Telegram is holding it open on purpose.
          new TelegramHttpTransport(telegramBotToken, fetch, 40_000),
          new PostgresUpdateOffsetStore(pool),
          new CompositeUpdateHandler([
            new TelegramApprovalUpdateHandler(
              new TelegramHttpTransport(telegramBotToken),
              new PostgresTelegramDecisionService(
                new PostgresApprovalRepository(pool),
                telegramChatId,
                telegramUserId,
              ),
            ),
            new TelegramConversationHandler({
              owner: new OwnerCommandService(
                new PostgresProjectFactory(pool),
                telegramConversations,
                telegramCommandSecret,
                new OrchestratorService(telegramConversations),
                // Same mechanism the Control API injects. Without it the
                // message would be stored and no reply ever queued -- which is
                // precisely the bug that made this handler silent.
                (input) => queueConversationReply(pool, input),
              ),
              conversations: telegramConversations,
              requester: new TelegramHttpTransport(telegramBotToken),
              csrfSecret: telegramCommandSecret,
            }),
            // Last in the chain, and it only answers slash messages. The
            // conversation handler ignores those, so exactly one of the two
            // responds to any given message.
            new TelegramCommandHandler({
              service: new TelegramCommandService(
                new PostgresCommandFacts(pool),
              ),
              requester: new TelegramHttpTransport(telegramBotToken),
            }),
          ]),
          [telegramChatId],
          [telegramUserId],
        )
      : undefined,
  providerArtifacts = new PostgresProviderArtifactStore(pool),
  aiPatchDriver = new AiPatchOperationDriver(
    new AiPatchExecutorDriver(
      aiGateway,
      new GitPatchApplier(),
      new SpawnWorkerRunner(),
      providerArtifacts,
      new GitIgnoringWorkspaceCopier(),
    ),
    new PostgresPolicyRouteResolver(
      new PostgresPolicyStore(pool),
      providerArtifacts,
      aiGateway,
      PROGRAMMING_POLICY_KEY,
    ),
    // An accepted patch advances the generated project to `development`.
    // Without this the lifecycle stopped at `blueprint` no matter how well
    // generation went, and the pipeline had no way to say it had finished.
    (input) =>
      new FactoryLifecycleAdvancer(new PostgresProjectFactory(pool)).developed(
        input.projectId,
        input.taskId,
      ),
  ),
  conversationReplyDriver = new ConversationReplyDriver(
    aiGateway,
    new PostgresConversationStore(pool),
    // Progress fragments have to be durable because this process is not the one
    // that serves them: the Control API holds the SSE connection
    // (CONTRACT-016 M2/M3).
    new PostgresReplyChunkStore(pool),
    // Wrapped so a database problem here costs tokens, never a reply: an
    // unavailable session store means the turn replays the transcript, which
    // is what every turn did before CONTRACT-017A.
    new ForgivingProviderSessionStore(new PostgresProviderSessionStore(pool)),
  ),
  blueprintTranslationDriver = new BlueprintTranslationDriver(
    aiGateway,
    new PostgresProjectFactory(pool),
  ),
  operation = new ExecutableTaskSupervisor(
    pool,
    work,
    new Map<string, OperationDriver>([
      ["deterministic_sha256", new DeterministicSha256Driver()],
      ["ai_patch_executor", aiPatchDriver],
      ["conversation_reply", conversationReplyDriver],
      ["blueprint_translation", blueprintTranslationDriver],
    ]),
    workerId,
    ttlMs,
    // Reporting is opt-in by configuration and never load-bearing: with no
    // Telegram credentials the supervisor behaves exactly as it did before, and
    // TelegramRunNotifier swallows every delivery failure by contract.
    runNotifier,
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

  // Prove the notification transport works before declaring readiness, so a
  // broken one is visible at boot rather than at the end of the first
  // successful task. Never fatal: notifications are not load-bearing, and a
  // supervisor that refuses to run because Telegram is unreachable would be
  // worse than one that runs quietly.
  if (runNotifier !== undefined) {
    const probe = await runNotifier.warmUp();
    console.log(
      JSON.stringify({
        event: "sequence.notifier.warmup",
        ok: probe.ok,
        detail: probe.detail,
      }),
    );
  }

  // Inbound Telegram runs as its own loop, deliberately separate from the task
  // loop above. A Telegram outage must be able to stall this and nothing else:
  // approvals arriving late is an inconvenience, tasks not executing is an
  // outage. pollOnce() never throws by contract, so this loop cannot end
  // except by shutdown.
  if (telegramPoller !== undefined)
    void (async () => {
      while (!stopping) {
        const outcome = await telegramPoller.pollOnce(operationSignal.signal);
        if (outcome.handled > 0 || outcome.refused > 0 || outcome.failed > 0)
          console.log(JSON.stringify({ event: "telegram.poll", ...outcome }));
        const wait = telegramPoller.backoffMs;
        if (wait > 0)
          await new Promise((resolve) => setTimeout(resolve, wait).unref());
      }
    })();

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
