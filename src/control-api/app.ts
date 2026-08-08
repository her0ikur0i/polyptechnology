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

  app.get("/api/v1/dashboard/snapshot", requireOwner, async (_req, res) => {
    try {
      const snapshot = await buildDashboardSnapshot(pool, csrfSecret);
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
        });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "invalid settings",
        });
      }
    },
  );

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
