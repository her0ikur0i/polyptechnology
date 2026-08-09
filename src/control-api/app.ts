import { join } from "node:path";
import express from "express";
import type { Express } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { OwnerCommandService } from "../operations/owner-commands.js";
import { PostgresProjectFactory } from "../factory/postgres-repository.js";
import { PostgresConversationStore } from "../orchestrator/postgres-store.js";
import { PostgresPolicyStore } from "../policy/postgres-policy-store.js";
import { OwnerPolicyService } from "../policy/owner-policy-service.js";
import { PostgresTelegramSettingsStore } from "./telegram-settings-store.js";
import { buildDashboardSnapshot } from "./snapshot.js";
import { identifyOwner, requireCsrf, requireOwner } from "./auth.js";
import { NodeWorkspaceProvisioner } from "../factory/workspace-provisioner.js";
import { createGenerationTask } from "../factory/generation-task.js";
import { parseBlueprint } from "../factory/blueprint.js";
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
  const owner = new OwnerCommandService(
    new PostgresProjectFactory(pool),
    new PostgresConversationStore(pool),
    csrfSecret,
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
