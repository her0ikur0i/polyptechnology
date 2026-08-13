import { join } from "node:path";
import { once } from "node:events";
import express from "express";
import { rateLimit } from "express-rate-limit";
import type { Express } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { OwnerCommandService } from "../operations/owner-commands.js";
import { PostgresProjectFactory } from "../factory/postgres-repository.js";
import { PostgresConversationStore } from "../orchestrator/postgres-store.js";
import { PostgresReplyChunkStore } from "../orchestrator/reply-chunks.js";
import { OrchestratorService } from "../orchestrator/service.js";
import { PostgresPolicyStore } from "../policy/postgres-policy-store.js";
import { OwnerPolicyService } from "../policy/owner-policy-service.js";
import { PostgresTelegramSettingsStore } from "./telegram-settings-store.js";
import { buildDashboardSnapshot } from "./snapshot.js";
import { identifyOwner, requireCsrf, requireOwner } from "./auth.js";
import { NodeWorkspaceProvisioner } from "../factory/workspace-provisioner.js";
import { createGenerationTask } from "../factory/generation-task.js";
import { FactoryLifecycleAdvancer } from "../factory/generation-lifecycle.js";
import { parseBlueprint } from "../factory/blueprint.js";
import { queueConversationReply } from "../orchestrator/reply-task.js";
import { queueBlueprintTranslation } from "../factory/blueprint-translation-task.js";
import {
  createAttachmentUpload,
  acceptAttachmentUpload,
} from "./attachment-upload.js";
import {
  createTelegramWebhookHandler,
  requireTelegramWebhookSecret,
} from "./telegram-webhook.js";
import { TelegramHttpTransport } from "../telegram/gateway.js";
import { renderReport } from "../telegram/report.js";

export interface ControlApiDeps {
  pool: Pool;
  config: AppConfig;
  csrfSecret?: string;
  dashboardDistPath?: string;
  telegramFetch?: typeof fetch;
}

// The Control API server ADR-0003 always assumed but never had: implements
// every route src/dashboard/api.ts (the client) already calls, plus owner
// policy routes wiring src/policy/owner-policy-service.ts. Queries and
// commands stay separate (buildDashboardSnapshot vs. the command services
// below), matching the ADR's stated boundary.
// Lower-case canonical form. Every comparison against it folds case first,
// because Express's router matches paths case-insensitively by default.
const TELEGRAM_WEBHOOK_PATH = "/api/v1/telegram/webhook";
const REPLY_STREAM_POLL_MS = 250;
const REPLY_STREAM_MAX_MS = 300_000;
const REPLY_STREAM_MAX_PER_TASK = 3;
const replyTaskCancelableStates = new Set([
  "queued",
  "leased",
  "running",
  "retry_wait",
  "needs_approval",
  "budget_blocked",
]);
const replyStreamTerminalStates = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "budget_blocked",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeReplyStreamsByTask = new Map<string, number>();

async function writeSse(
  res: express.Response,
  payload: string,
  deadlineMs: number,
): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(payload)) return true;
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  const timedOut = Symbol("timed-out");
  const result = await Promise.race([
    once(res, "drain").then(() => true),
    once(res, "close").then(() => false),
    sleep(remainingMs).then(() => timedOut),
  ]);
  if (result === timedOut) {
    res.end();
    return false;
  }
  return result === true;
}

export function createControlApi(deps: ControlApiDeps): Express {
  const { pool, config } = deps;
  const csrfSecret = deps.csrfSecret ?? config.csrfSecret;
  const conversations = new PostgresConversationStore(pool);
  const replyChunks = new PostgresReplyChunkStore(pool);
  const orchestrator = new OrchestratorService(conversations);
  const owner = new OwnerCommandService(
    new PostgresProjectFactory(pool),
    conversations,
    csrfSecret,
    orchestrator,
    // Queues the assistant reply as a real background task -- never a
    // synchronous AiGateway call inside a request/response cycle, matching how
    // /generate queues rather than executes inline.
    (input) => queueConversationReply(pool, input),
  );
  const policyStore = new PostgresPolicyStore(pool);
  const policy = new OwnerPolicyService(policyStore, csrfSecret);
  const telegram = new PostgresTelegramSettingsStore(pool);
  const telegramFetcher = deps.telegramFetch ?? fetch;

  const app = express();
  app.set("trust proxy", config.trustedProxyHops);
  app.use(express.json({ limit: "256kb" }));
  app.use(identifyOwner(config));

  // Request throttling (CONTRACT-015 M3). The control plane spends real money
  // per request through AiGateway, so this is a budget control as much as an
  // availability one: src/gateway/postgres-ledger.ts caps spend per contract
  // scope, but until now nothing capped request volume, so a flood could burn
  // budget and CPU right up to that cap.
  //
  // Deliberately generous. The dashboard's busiest long-lived pattern is the
  // reply SSE stream in src/dashboard/conversation-workspace.tsx, with status
  // polling retained only as a fallback. API_RATE_LIMIT_PER_MINUTE exists so a
  // protection against floods can never itself become the thing that locks the
  // owner out of their own control plane.
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.apiRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate limited" },
  });
  // The Telegram webhook is authenticated by secret_token rather than by owner
  // session, so it gets its own budget. Keeping the two separate means inbound
  // Telegram traffic can never exhaust the owner's allowance, and the owner's
  // dashboard use can never exhaust the webhook's -- which matters because both
  // arrive through the same tunnel and therefore share a client address.
  //
  // Split into two tiers after the CONTRACT-015 M8 review: the webhook is the
  // one route reachable without Cloudflare Access (Telegram cannot do
  // interactive SSO), so an anonymous caller who merely knows the fixed path
  // could previously spend the entire protective budget on rejected requests
  // and deny the owner's real approval callbacks -- a credential-free DoS on
  // the approval channel.
  //
  // Now the configured ceiling is consumed only AFTER the secret validates,
  // and unauthenticated traffic is held off by a separate, looser guard that
  // exists to protect CPU rather than to ration Telegram. An attacker
  // exhausting the guard tier cannot touch the authenticated tier.
  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.webhookRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate limited" },
  });
  const webhookGuardLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.webhookRateLimitPerMinute * 4,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate limited" },
  });
  // Applied by explicit dispatch rather than app.use("/api/", ...) so the
  // matching is on the full path and cannot be confused by mount-path
  // stripping. Static assets and the SPA fallback are never throttled.
  //
  // Case-folded, and this is not cosmetic. Express matches routes
  // case-insensitively unless "case sensitive routing" is enabled, which this
  // app never enables -- so a case-sensitive comparison here disagreed with the
  // router about which requests exist. `/API/v1/dashboard/snapshot` reached the
  // real handler with no throttle at all, which meant the limiter M3 added to
  // protect the AI budget could be skipped by holding down shift. Shipped
  // broken in M3, found by the M8 independent review, verified before and after
  // by live request.
  app.use((req, res, next) => {
    const path = req.path.toLowerCase();
    if (!path.startsWith("/api/")) return next();
    return path === TELEGRAM_WEBHOOK_PATH
      ? webhookGuardLimiter(req, res, next)
      : apiLimiter(req, res, next);
  });

  const webhookRegistered =
    config.telegramWebhookSecret !== undefined &&
    config.telegramChatId !== undefined &&
    config.telegramUserId !== undefined;

  app.get("/api/v1/dashboard/snapshot", requireOwner, async (_req, res) => {
    try {
      const snapshot = await buildDashboardSnapshot(
        pool,
        csrfSecret,
        webhookRegistered,
      );
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "snapshot unavailable",
      });
    }
  });

  app.put(
    "/api/v1/settings/telegram",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const saved = await telegram.save(req.body, req.owner!.actorId);
        res.json({
          ...(saved.secretRef ? { secretRef: saved.secretRef } : {}),
          authorizedChatIds: saved.authorizedChatIds,
          authorizedUserIds: saved.authorizedUserIds,
          configurationReady:
            saved.secretRef !== null &&
            saved.authorizedChatIds.length > 0 &&
            saved.authorizedUserIds.length > 0,
          lastCheckedAt: saved.updatedAt.toISOString(),
          liveProbeState: "not_run",
          approvalRequiredForProbe: true,
          webhookRegistered,
        });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "invalid settings",
        });
      }
    },
  );

  app.post(
    "/api/v1/settings/telegram/test",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const kind = req.body?.kind;
        if (kind !== "connectivity" && kind !== "test_message")
          throw new Error("invalid telegram test kind");
        if (config.telegramBotToken === undefined)
          throw new Error("telegram bot token is not configured");
        if (kind === "test_message" && config.telegramChatId === undefined)
          throw new Error("telegram chat id is not configured");
        const transport = new TelegramHttpTransport(
          config.telegramBotToken,
          telegramFetcher,
        );
        if (kind === "connectivity") {
          await transport.call("getMe", {});
          res.json({
            state: "passed",
            checkedAt: new Date().toISOString(),
            summary: "Telegram bot connectivity passed.",
          });
          return;
        }
        const text = renderReport({
          category: "success",
          title: "Telegram test message",
          subject: "Polyp AI Factory",
          detail: [
            {
              icon: "warning",
              text: "This is a bounded <owner>&dashboard connectivity test.",
            },
            {
              icon: "gate",
              text: "Operational reports stay terminal, human-readable and quiet.",
            },
          ],
        });
        if (text.length > 4_000)
          throw new Error("telegram test message exceeds safe length");
        await transport.call("sendMessage", {
          chat_id: config.telegramChatId,
          text,
          parse_mode: "HTML",
        });
        res.json({
          state: "passed",
          checkedAt: new Date().toISOString(),
          summary: "Telegram test message sent.",
        });
      } catch (error) {
        res.status(400).json({
          state: "failed",
          checkedAt: new Date().toISOString(),
          summary:
            error instanceof Error ? error.message : "Telegram test failed.",
        });
      }
    },
  );

  // Telegram calls this route, not the owner's authenticated browser -- it
  // is gated by the webhook secret header (Telegram's own setWebhook
  // secret_token mechanism), never by requireOwner/CSRF. Only registered
  // when all three of TELEGRAM_WEBHOOK_SECRET/TELEGRAM_CHAT_ID/
  // TELEGRAM_USER_ID are configured -- absent config means the route does
  // not exist at all, failing closed by omission rather than accepting
  // unauthenticated callbacks (docs/operations/telegram-approvals.md:
  // "Absence/failure must remain fail-closed").
  if (
    config.telegramWebhookSecret !== undefined &&
    config.telegramChatId !== undefined &&
    config.telegramUserId !== undefined
  ) {
    app.post(
      TELEGRAM_WEBHOOK_PATH,
      requireTelegramWebhookSecret(config.telegramWebhookSecret),
      // After the secret check on purpose: only callers that proved they are
      // Telegram consume the configured ceiling. Anonymous traffic is already
      // held by webhookGuardLimiter above and never reaches here.
      webhookLimiter,
      createTelegramWebhookHandler(
        pool,
        config.telegramChatId,
        config.telegramUserId,
      ),
    );
  }

  app.post(
    "/api/v1/factory/projects",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await owner.createProject(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          req.body,
        );
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error ? error.message : "project command failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/factory/projects/:id/generate",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const projectId = req.params.id;
        if (typeof projectId !== "string")
          throw new Error("invalid project id");
        const factory = new PostgresProjectFactory(pool);
        const project = await factory.getProject(projectId);
        if (project === undefined) throw new Error("project not found");
        const versionRow = await pool.query<{ document: unknown }>(
          "SELECT document FROM project_blueprint_versions WHERE id=$1",
          [project.blueprintVersionId],
        );
        if (versionRow.rowCount !== 1)
          throw new Error("blueprint version not found");
        const blueprint = parseBlueprint(versionRow.rows[0]!.document);
        const provisioner = new NodeWorkspaceProvisioner(
          config.projectWorkspacesRoot,
        );
        const { repoPath } = await provisioner.provision(project.id, blueprint);
        // The workspace now exists on disk as a real git repository, so the
        // project's recorded state should say so. Nothing wrote `provisioned`
        // before CONTRACT-017C — the lifecycle defined the state and no code
        // ever reached it.
        await new FactoryLifecycleAdvancer(factory).provisioned(
          project.id,
          project.workspaceRef,
        );
        const task = await createGenerationTask(
          pool,
          project,
          blueprint,
          repoPath,
        );
        res.status(201).json(task);
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error
              ? error.message
              : "generation command failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/proposals",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await owner.createProposal(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          req.body,
        );
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error ? error.message : "proposal command failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/conversations/:id/proposals",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const conversationId = req.params.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid conversation id");
        const result = await owner.draftProposal(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          { ...req.body, conversationId },
        );
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "draft failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/proposals/:id/approve",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const proposalId = req.params.id;
        if (typeof proposalId !== "string")
          throw new Error("invalid proposal id");
        const result = await owner.approveProposal(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          { ...req.body, proposalId },
        );
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "approve failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/proposals/:id/reject",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const proposalId = req.params.id;
        if (typeof proposalId !== "string")
          throw new Error("invalid proposal id");
        const result = await owner.rejectProposal(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          { ...req.body, proposalId },
        );
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "reject failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/proposals/:id/translate",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const proposalId = req.params.id;
        const projectId = req.body.projectId;
        if (
          typeof proposalId !== "string" ||
          typeof projectId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(projectId)
        )
          throw new Error("invalid proposal or project id");
        const proposal = await conversations.proposal(projectId, proposalId);
        if (proposal === undefined) throw new Error("proposal not found");
        if (proposal.state !== "handed_off")
          throw new Error(
            "only a handed-off proposal can be translated into a blueprint",
          );
        const factory = new PostgresProjectFactory(pool);
        const project = await factory.getProject(projectId);
        if (project === undefined) throw new Error("project not found");
        const queued = await queueBlueprintTranslation(pool, {
          projectId,
          proposalId,
          contractCandidate: proposal.contractCandidate,
          expectedProjectVersion: project.version,
        });
        res.status(201).json(queued);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "translate failed",
        });
      }
    },
  );

  app.get(
    "/api/v1/orchestrator/proposals/:id",
    requireOwner,
    async (req, res) => {
      try {
        const proposalId = req.params.id;
        const projectId = req.query.projectId;
        if (typeof proposalId !== "string" || typeof projectId !== "string")
          throw new Error("invalid proposal or project id");
        const proposal = await conversations.proposal(projectId, proposalId);
        if (proposal === undefined) throw new Error("proposal not found");
        res.json(proposal);
      } catch (error) {
        res.status(404).json({
          error:
            error instanceof Error ? error.message : "proposal unavailable",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/conversations",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await owner.startConversation(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          req.body,
        );
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error
              ? error.message
              : "conversation command failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/conversations/:id/messages",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const conversationId = req.params.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid conversation id");
        const message = await owner.sendMessage(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          { ...req.body, conversationId },
        );
        // The reply is queued by OwnerCommandService, not here. It used to be
        // queued in this route, which meant a second caller could go through
        // the service, store a message correctly, and silently never get a
        // reply -- exactly what happened to the Telegram path. Sequencing that
        // belongs to the domain does not live in a transport handler.
        const { replyTaskId, ...stored } = message as typeof message & {
          replyTaskId?: string;
        };
        res.status(201).json({ message: stored, replyTaskId });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "message send failed",
        });
      }
    },
  );

  app.get(
    "/api/v1/orchestrator/reply-tasks/:taskId",
    requireOwner,
    async (req, res) => {
      try {
        const taskId = req.params.taskId;
        if (typeof taskId !== "string" || !/^[a-f0-9-]{36}$/.test(taskId))
          throw new Error("invalid task id");
        const result = await pool.query<{ state: string }>(
          "SELECT state FROM tasks WHERE id=$1",
          [taskId],
        );
        if (result.rowCount !== 1) throw new Error("reply task not found");
        res.json({ taskId, state: result.rows[0]!.state });
      } catch (error) {
        res.status(404).json({
          error: error instanceof Error ? error.message : "task unavailable",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/reply-tasks/:taskId/cancel",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      const taskId = req.params.taskId;
      if (typeof taskId !== "string" || !/^[a-f0-9-]{36}$/.test(taskId)) {
        res.status(400).json({ error: "invalid task id" });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const task = await client.query<{
          state: string;
          attempt_count: number;
        }>(
          "SELECT t.state,t.attempt_count FROM tasks t JOIN operation_task_specs s ON s.task_id=t.id WHERE t.id=$1 AND s.driver='conversation_reply' FOR UPDATE OF t",
          [taskId],
        );
        if (task.rowCount !== 1) {
          await client.query("ROLLBACK");
          res.status(404).json({ error: "reply task not found" });
          return;
        }
        const row = task.rows[0]!;
        if (!replyTaskCancelableStates.has(row.state)) {
          await client.query("ROLLBACK");
          res.json({ taskId, state: row.state });
          return;
        }
        await client.query(
          "UPDATE tasks SET state='cancelled',next_attempt_at=NULL WHERE id=$1",
          [taskId],
        );
        await client.query("DELETE FROM task_leases WHERE task_id=$1", [
          taskId,
        ]);
        if (row.attempt_count > 0)
          await client.query(
            "UPDATE task_attempts SET state='cancelled',failure_reason='worker',finished_at=CURRENT_TIMESTAMP WHERE task_id=$1 AND ordinal=$2 AND finished_at IS NULL",
            [taskId, row.attempt_count],
          );
        await client.query("COMMIT");
        res.json({ taskId, state: "cancelled" });
      } catch (error) {
        await client.query("ROLLBACK");
        res.status(400).json({
          error: error instanceof Error ? error.message : "task cancel failed",
        });
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/api/v1/orchestrator/reply-tasks/:taskId/stream",
    requireOwner,
    async (req, res) => {
      const taskId = req.params.taskId;
      const after =
        typeof req.query.after === "string" ? Number(req.query.after) : 0;
      if (
        typeof taskId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(taskId) ||
        !Number.isInteger(after) ||
        after < 0
      ) {
        res.status(400).json({ error: "invalid stream cursor" });
        return;
      }

      const task = await pool.query<{ state: string }>(
        "SELECT state FROM tasks WHERE id=$1",
        [taskId],
      );
      if (task.rowCount !== 1) {
        res.status(404).json({ error: "reply task not found" });
        return;
      }
      const active = activeReplyStreamsByTask.get(taskId) ?? 0;
      if (active >= REPLY_STREAM_MAX_PER_TASK) {
        res.status(429).json({ error: "too many reply streams" });
        return;
      }
      activeReplyStreamsByTask.set(taskId, active + 1);

      let closed = false;
      const openedAt = Date.now();
      const deadlineMs = openedAt + REPLY_STREAM_MAX_MS;
      req.on("close", () => {
        closed = true;
      });
      try {
        res.status(200);
        res.set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        let cursor = after;
        let state = task.rows[0]!.state;
        while (!closed) {
          const chunks = await replyChunks.since(taskId, cursor);
          for (const chunk of chunks) {
            cursor = chunk.ordinal;
            if (
              !(await writeSse(
                res,
                `event: chunk\ndata: ${JSON.stringify(chunk)}\nid: ${chunk.ordinal}\n\n`,
                deadlineMs,
              ))
            )
              return;
          }

          const current = await pool.query<{ state: string }>(
            "SELECT state FROM tasks WHERE id=$1",
            [taskId],
          );
          state = current.rows[0]?.state ?? "cancelled";
          if (replyStreamTerminalStates.has(state)) {
            await writeSse(
              res,
              `event: done\ndata: ${JSON.stringify({ state })}\n\n`,
              deadlineMs,
            );
            res.end();
            return;
          }
          if (Date.now() >= deadlineMs) {
            await writeSse(
              res,
              `event: retry\ndata: ${JSON.stringify({ after: cursor })}\n\n`,
              deadlineMs,
            );
            res.end();
            return;
          }
          if (chunks.length === 0)
            await writeSse(res, ": keep-alive\n\n", deadlineMs);
          await sleep(REPLY_STREAM_POLL_MS);
        }
      } finally {
        const remaining = (activeReplyStreamsByTask.get(taskId) ?? 1) - 1;
        if (remaining <= 0) activeReplyStreamsByTask.delete(taskId);
        else activeReplyStreamsByTask.set(taskId, remaining);
      }
    },
  );

  app.get(
    "/api/v1/orchestrator/conversations/:id/messages",
    requireOwner,
    async (req, res) => {
      try {
        const conversationId = req.params.id;
        const projectId = req.query.projectId;
        if (typeof conversationId !== "string" || typeof projectId !== "string")
          throw new Error("invalid conversation or project id");
        res.json(await conversations.messages(projectId, conversationId));
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error ? error.message : "messages unavailable",
        });
      }
    },
  );

  const attachmentUpload = createAttachmentUpload(config.attachmentStorageRoot);

  app.post(
    "/api/v1/orchestrator/conversations/:id/attachments",
    requireOwner,
    requireCsrf(csrfSecret),
    (req, res) => {
      // multer's own middleware form reports errors (oversized file,
      // disallowed type via fileFilter) to Express's default HTML error
      // handler, not this route's JSON error shape -- invoking it directly
      // with its callback form instead keeps every failure mode (bad
      // request body, upload rejection, downstream validation) on the same
      // clean `{ error }` JSON contract every other route uses.
      attachmentUpload.single("file")(req, res, async (err: unknown) => {
        if (err) {
          res.status(400).json({
            error: err instanceof Error ? err.message : "upload rejected",
          });
          return;
        }
        try {
          const conversationId = req.params.id;
          const projectId = req.body.projectId;
          if (
            typeof conversationId !== "string" ||
            typeof projectId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(projectId)
          )
            throw new Error("invalid conversation or project id");
          if (!req.file)
            throw new Error(
              "no file uploaded, or its type is not on the allowed list",
            );
          const attachment = await acceptAttachmentUpload(conversations, {
            conversationId,
            projectId,
            storedPath: req.file.path,
            storedFilename: req.file.filename,
            displayName: req.file.originalname,
            mediaType: req.file.mimetype,
            sizeBytes: req.file.size,
          });
          res.status(201).json(attachment);
        } catch (error) {
          res.status(400).json({
            error: error instanceof Error ? error.message : "upload failed",
          });
        }
      });
    },
  );

  app.get(
    "/api/v1/orchestrator/conversations/:id/attachments",
    requireOwner,
    async (req, res) => {
      try {
        const conversationId = req.params.id;
        const projectId = req.query.projectId;
        if (typeof conversationId !== "string" || typeof projectId !== "string")
          throw new Error("invalid conversation or project id");
        res.json(await conversations.attachments(projectId, conversationId));
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error ? error.message : "attachments unavailable",
        });
      }
    },
  );

  app.get(
    "/api/v1/orchestrator/projects/:projectId/conversations",
    requireOwner,
    async (req, res) => {
      try {
        const projectId = req.params.projectId;
        if (typeof projectId !== "string")
          throw new Error("invalid project id");
        const search = req.query.search;
        res.json(
          await conversations.listConversations(projectId, {
            ...(typeof search === "string" && search.length > 0
              ? { search }
              : {}),
            includeArchived: req.query.includeArchived === "true",
          }),
        );
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error
              ? error.message
              : "conversations unavailable",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/conversations/:id/rename",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const conversationId = req.params.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid conversation id");
        const result = await owner.renameConversation(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          { ...req.body, conversationId },
        );
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "rename failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/orchestrator/conversations/:id/archive",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const conversationId = req.params.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid conversation id");
        const result = await owner.setConversationArchived(
          {
            authenticated: true,
            actorId: req.owner!.actorId,
            csrfToken: csrfSecret,
          },
          {
            ...req.body,
            conversationId,
            archived: req.body.archived !== false,
          },
        );
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "archive failed",
        });
      }
    },
  );

  const policyContext = (req: express.Request) => ({
    authenticated: true,
    actorId: req.owner!.actorId,
    csrfToken: csrfSecret,
  });
  const occurredAt = () => new Date().toISOString();

  app.post(
    "/api/v1/policy/draft",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await policy.createDraft(policyContext(req), {
          ...req.body,
          occurredAt: occurredAt(),
        });
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "draft failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/policy/validate",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await policy.validateDraft(policyContext(req), {
          ...req.body,
          occurredAt: occurredAt(),
        });
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "validate failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/policy/approve",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await policy.approve(policyContext(req), {
          ...req.body,
          occurredAt: occurredAt(),
        });
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "approve failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/policy/activate",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await policy.activate(policyContext(req), {
          ...req.body,
          occurredAt: occurredAt(),
        });
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "activate failed",
        });
      }
    },
  );

  app.post(
    "/api/v1/policy/rollback",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await policy.rollback(policyContext(req), {
          ...req.body,
          occurredAt: occurredAt(),
        });
        res.json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "rollback failed",
        });
      }
    },
  );

  app.get(
    "/api/v1/policy/:policyKey/active",
    requireOwner,
    async (req, res) => {
      try {
        const policyKey = req.params.policyKey;
        if (typeof policyKey !== "string")
          throw new Error("invalid policy key");
        const active = await policyStore.active(policyKey);
        res.json(active);
      } catch (error) {
        res.status(404).json({
          error: error instanceof Error ? error.message : "no active policy",
        });
      }
    },
  );

  app.post("/api/v1/policy/simulate", requireOwner, async (req, res) => {
    try {
      const result = await policy.simulate(policyContext(req), {
        ...req.body,
        occurredAt: occurredAt(),
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "simulate failed",
      });
    }
  });

  app.post(
    "/api/v1/policy/codex-override",
    requireOwner,
    requireCsrf(csrfSecret),
    async (req, res) => {
      try {
        const result = await policy.createCodexOverride(policyContext(req), {
          ...req.body,
          occurredAt: occurredAt(),
        });
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "override failed",
        });
      }
    },
  );

  if (deps.dashboardDistPath) {
    // Defence in depth alongside vite.config.ts's sourcemap:false. Even if a
    // build somewhere re-enables map emission, the server refuses to hand the
    // dashboard's original source to a browser (CONTRACT-015 M3).
    app.use((req, res, next) => {
      // Case-folded for the same reason the limiter dispatch is: a
      // case-sensitive suffix test disagrees with what the filesystem may
      // serve. Nothing leaked in practice here, because the static root is
      // case-sensitive Linux and a mismatched-case request fell through to the
      // SPA fallback -- but that is the filesystem upholding the promise, not
      // this guard. Tightened by the CONTRACT-015 M8 review.
      if (req.path.toLowerCase().endsWith(".map")) {
        res.status(404).json({ error: "not found" });
        return;
      }
      next();
    });
    app.use(express.static(deps.dashboardDistPath));
    app.get("/*splat", (req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(join(deps.dashboardDistPath!, "index.html"));
    });
  }

  return app;
}
