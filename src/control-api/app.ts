import { join } from "node:path";
import express from "express";
import type { Express } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { OwnerCommandService } from "../operations/owner-commands.js";
import { PostgresProjectFactory } from "../factory/postgres-repository.js";
import { PostgresConversationStore } from "../orchestrator/postgres-store.js";
import { OrchestratorService } from "../orchestrator/service.js";
import { PostgresPolicyStore } from "../policy/postgres-policy-store.js";
import { OwnerPolicyService } from "../policy/owner-policy-service.js";
import { PostgresTelegramSettingsStore } from "./telegram-settings-store.js";
import { buildDashboardSnapshot } from "./snapshot.js";
import { identifyOwner, requireCsrf, requireOwner } from "./auth.js";
import { NodeWorkspaceProvisioner } from "../factory/workspace-provisioner.js";
import { createGenerationTask } from "../factory/generation-task.js";
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

export interface ControlApiDeps {
  pool: Pool;
  config: AppConfig;
  csrfSecret?: string;
  dashboardDistPath?: string;
}

// The Control API server ADR-0003 always assumed but never had: implements
// every route src/dashboard/api.ts (the client) already calls, plus owner
// policy routes wiring src/policy/owner-policy-service.ts. Queries and
// commands stay separate (buildDashboardSnapshot vs. the command services
// below), matching the ADR's stated boundary.
export function createControlApi(deps: ControlApiDeps): Express {
  const { pool, config } = deps;
  const csrfSecret = deps.csrfSecret ?? config.csrfSecret;
  const conversations = new PostgresConversationStore(pool);
  const orchestrator = new OrchestratorService(conversations);
  const owner = new OwnerCommandService(
    new PostgresProjectFactory(pool),
    conversations,
    csrfSecret,
    orchestrator,
  );
  const policyStore = new PostgresPolicyStore(pool);
  const policy = new OwnerPolicyService(policyStore, csrfSecret);
  const telegram = new PostgresTelegramSettingsStore(pool);

  const app = express();
  app.set("trust proxy", config.trustedProxyHops);
  app.use(express.json({ limit: "256kb" }));
  app.use(identifyOwner(config));

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
      "/api/v1/telegram/webhook",
      requireTelegramWebhookSecret(config.telegramWebhookSecret),
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
        // Queues the assistant reply as a real background task -- never a
        // synchronous AiGateway call inside this request/response cycle,
        // matching how /generate queues rather than executes inline (M5).
        // The reply won't actually run until a supervisor process with
        // real provider credentials is running, which the Control API
        // process deliberately never is (CONTRACT-013 M9 decision 4).
        const reply = await queueConversationReply(pool, {
          conversationId,
          projectId: message.projectId,
          expectedVersion: message.ordinal,
        });
        res.status(201).json({ message, replyTaskId: reply.taskId });
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
