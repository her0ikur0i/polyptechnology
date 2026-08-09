import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import type { AddressInfo } from "node:net";
import { createControlApi } from "../src/control-api/app.js";
import { loadConfig } from "../src/config.js";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import type { RuntimePolicy } from "../src/policy/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const validRuntimePolicy: RuntimePolicy = {
  routesByTaskClass: {
    bulk_code: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        priority: 0,
      },
      { provider: "claude", requestedModelId: "claude-sonnet-5", priority: 1 },
    ],
    complex_backend: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        priority: 0,
      },
      { provider: "claude", requestedModelId: "claude-opus-4-8", priority: 1 },
    ],
    bounded_repair: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        priority: 0,
      },
      { provider: "claude", requestedModelId: "claude-sonnet-5", priority: 1 },
    ],
  },
  envelope: {
    softBudgetUsdMicros: 1_000,
    emergencyCostCeilingUsdMicros: 2_000,
    maxOutputTokens: 4_096,
    maxTurns: 5,
    timeoutMs: 30_000,
    concurrency: 2,
  },
};

async function withServer<T>(
  accessAuthMode: "disabled" | "cloudflare",
  run: (baseUrl: string, csrfSecret: string) => Promise<T>,
  dashboardDistPath?: string,
): Promise<T> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const csrfSecret = "test-csrf-secret-".padEnd(40, "x");
  const config = loadConfig({
    ...process.env,
    ACCESS_AUTH_MODE: accessAuthMode,
    NODE_ENV: "test",
    PROJECT_WORKSPACES_ROOT: mkdtempSync(
      join(tmpdir(), "control-api-workspaces-"),
    ),
  });
  const app = createControlApi({
    pool,
    config,
    csrfSecret,
    ...(dashboardDistPath ? { dashboardDistPath } : {}),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("server did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl, csrfSecret);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

test(
  "cloudflare auth mode rejects requests without the identity header",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("cloudflare", async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/dashboard/snapshot`);
      assert.equal(response.status, 401);
    });
  },
);

test(
  "cloudflare auth mode rejects every requireOwner route without the identity header",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("cloudflare", async (baseUrl, csrfSecret) => {
      const unauthorized: Array<{ path: string; init?: RequestInit }> = [
        { path: "/api/v1/dashboard/snapshot" },
        { path: "/api/v1/policy/programming-routes/active" },
        {
          path: "/api/v1/factory/projects",
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrfSecret,
            },
            body: "{}",
          },
        },
        {
          path: "/api/v1/policy/draft",
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrfSecret,
            },
            body: "{}",
          },
        },
        {
          path: "/api/v1/orchestrator/proposals",
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrfSecret,
            },
            body: "{}",
          },
        },
      ];
      // A valid CSRF token alone must never substitute for owner
      // authentication -- requireOwner runs independently of requireCsrf on
      // every one of these routes (src/control-api/app.ts), so all of them
      // must reject with 401, not fall through to a CSRF or validation
      // error that would leak past the authentication boundary.
      for (const { path, init } of unauthorized) {
        const response = await fetch(`${baseUrl}${path}`, init);
        assert.equal(response.status, 401, path);
      }
    });
  },
);

test(
  "a restart issues a fresh ephemeral CSRF secret that invalidates the previous process's token",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    async function startEphemeralServer() {
      // No CSRF_SECRET/deps.csrfSecret override -- config.ts generates a
      // fresh randomBytes(32) secret per process in dev/test, exactly as a
      // real restart would (docs/RESUME.md: "restarts simply invalidate any
      // cached client token, which is expected and safe").
      const config = loadConfig({
        ...process.env,
        ACCESS_AUTH_MODE: "disabled",
        NODE_ENV: "test",
        CSRF_SECRET: undefined,
        PROJECT_WORKSPACES_ROOT: mkdtempSync(
          join(tmpdir(), "control-api-restart-"),
        ),
      });
      const app = createControlApi({ pool, config });
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        csrfSecret: config.csrfSecret,
        close: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }
    try {
      const first = await startEphemeralServer();
      const second = await startEphemeralServer();
      try {
        assert.notEqual(first.csrfSecret, second.csrfSecret);
        const staleTokenAgainstNewProcess = await fetch(
          `${second.baseUrl}/api/v1/settings/telegram`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": first.csrfSecret,
            },
            body: JSON.stringify({
              secretRef: "secret://polyp/telegram/bot",
              authorizedChatIds: ["-1001"],
              authorizedUserIds: ["42"],
            }),
          },
        );
        assert.equal(staleTokenAgainstNewProcess.status, 403);

        const freshTokenAgainstNewProcess = await fetch(
          `${second.baseUrl}/api/v1/settings/telegram`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": second.csrfSecret,
            },
            body: JSON.stringify({
              secretRef: "secret://polyp/telegram/bot",
              authorizedChatIds: ["-1001"],
              authorizedUserIds: ["42"],
            }),
          },
        );
        assert.equal(freshTokenAgainstNewProcess.status, 200);
      } finally {
        await first.close();
        await second.close();
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  "disabled auth mode serves an authenticated snapshot with real data shape",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/dashboard/snapshot`);
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.ok(typeof snapshot.commandPolicy.csrfToken === "string");
      assert.ok(Array.isArray(snapshot.projects.data));
      assert.ok(Array.isArray(snapshot.contracts.data));
      assert.ok(Array.isArray(snapshot.attempts.data));
      assert.ok(Array.isArray(snapshot.approvals.data));
      assert.ok(typeof snapshot.telegram.data.configurationReady === "boolean");
      assert.ok(typeof snapshot.sequence.data.state === "string");
    });
  },
);

test(
  "settings write requires a matching CSRF token and persists",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const command = {
        secretRef: "secret://polyp/telegram/bot",
        authorizedChatIds: ["-1001"],
        authorizedUserIds: ["42"],
      };
      const noToken = await fetch(`${baseUrl}/api/v1/settings/telegram`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      assert.equal(noToken.status, 403);

      const withToken = await fetch(`${baseUrl}/api/v1/settings/telegram`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfSecret,
        },
        body: JSON.stringify(command),
      });
      assert.equal(withToken.status, 200);
      const saved = await withToken.json();
      assert.equal(saved.configurationReady, true);
      // secretRef is a reference string ("secret://..."), not the bot token
      // itself -- safe to display, and the dashboard Settings page does.
      // The actual TELEGRAM_BOT_TOKEN never enters this store or response.
      assert.equal(saved.secretRef, "secret://polyp/telegram/bot");

      const snapshot = await (
        await fetch(`${baseUrl}/api/v1/dashboard/snapshot`)
      ).json();
      assert.equal(snapshot.telegram.data.configurationReady, true);
      assert.deepEqual(snapshot.telegram.data.authorizedChatIds, ["-1001"]);
    });
  },
);

test(
  "creating a project and a proposal flows through to the snapshot",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const slug = `ctrl-api-${randomUUID().slice(0, 8)}`;
      const projectResponse = await fetch(
        `${baseUrl}/api/v1/factory/projects`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfSecret,
          },
          body: JSON.stringify({
            slug,
            displayName: "Control API test project",
            runtime: "node",
            framework: "express",
            database: "postgres",
            requirements: ["ship it"],
            // Matches what src/dashboard/api.ts's createFactoryProject()
            // actually sends -- the client generates these, not the server.
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      const project = await projectResponse.json();
      assert.equal(projectResponse.status, 201, JSON.stringify(project));
      assert.equal(project.state, "blueprint");

      const proposalResponse = await fetch(
        `${baseUrl}/api/v1/orchestrator/proposals`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfSecret,
          },
          body: JSON.stringify({
            projectId: project.projectId,
            title: "Initial contract",
            objective: "Deliver the first working slice of the product.",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      assert.equal(proposalResponse.status, 201);

      const snapshot = await (
        await fetch(`${baseUrl}/api/v1/dashboard/snapshot`)
      ).json();
      assert.ok(
        snapshot.projects.data.some(
          (p: { id: string }) => p.id === project.projectId,
        ),
      );
    });
  },
);

test(
  "generating a project provisions a real workspace and queues a real task",
  { skip: databaseUrl === undefined, timeout: 30_000 },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const slug = `ctrl-api-gen-${randomUUID().slice(0, 8)}`;
      const projectResponse = await fetch(
        `${baseUrl}/api/v1/factory/projects`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfSecret,
          },
          body: JSON.stringify({
            slug,
            displayName: "Generate Route Test",
            runtime: "node",
            framework: "none",
            database: "none",
            requirements: ["Expose a health check"],
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      const project = await projectResponse.json();
      assert.equal(projectResponse.status, 201, JSON.stringify(project));

      const noToken = await fetch(
        `${baseUrl}/api/v1/factory/projects/${project.projectId}/generate`,
        { method: "POST" },
      );
      assert.equal(noToken.status, 403);

      const generateResponse = await fetch(
        `${baseUrl}/api/v1/factory/projects/${project.projectId}/generate`,
        {
          method: "POST",
          headers: { "x-csrf-token": csrfSecret },
        },
      );
      const generated = await generateResponse.json();
      assert.equal(generateResponse.status, 201, JSON.stringify(generated));
      assert.match(generated.taskId, /^[a-f0-9-]{36}$/);

      // This test only proves the task was queued, it never runs a
      // supervisor against it -- left `queued`, it's a landmine for any
      // *other* test's ExecutableTaskSupervisor.runOne() (that query has no
      // per-test scoping, see src/operations/execution-supervisor.ts).
      // Cancel it explicitly rather than leaving real state behind.
      const cleanupPool = new pg.Pool({ connectionString: databaseUrl });
      try {
        await new PostgresWorkRepository(cleanupPool).controlTransition(
          generated.taskId,
          "queued",
          "cancelled",
        );
      } finally {
        await cleanupPool.end();
      }
    });
  },
);

test(
  "full policy lifecycle: draft -> validate -> approve -> activate -> simulate",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const policyKey = `test-policy-${randomUUID().slice(0, 8)}`;

      const draft = await (
        await fetch(`${baseUrl}/api/v1/policy/draft`, {
          method: "POST",
          headers,
          body: JSON.stringify({ policyKey, policy: validRuntimePolicy }),
        })
      ).json();
      assert.equal(draft.state, "draft");

      const validated = await (
        await fetch(`${baseUrl}/api/v1/policy/validate`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: draft.id,
            expectedVersion: draft.version,
          }),
        })
      ).json();
      assert.equal(validated.state, "validated");

      const approved = await (
        await fetch(`${baseUrl}/api/v1/policy/approve`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: draft.id,
            expectedVersion: draft.version,
          }),
        })
      ).json();
      assert.equal(approved.state, "approved");

      const activated = await (
        await fetch(`${baseUrl}/api/v1/policy/activate`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: draft.id,
            expectedVersion: draft.version,
          }),
        })
      ).json();
      assert.equal(activated.state, "active");

      const activeView = await (
        await fetch(`${baseUrl}/api/v1/policy/${policyKey}/active`)
      ).json();
      assert.equal(activeView.state, "active");
      assert.equal(activeView.policyKey, policyKey);

      const simulated = await (
        await fetch(`${baseUrl}/api/v1/policy/simulate`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            policyKey,
            taskClass: "bulk_code",
            taskId: randomUUID(),
            availableModelKeys: ["deepseek:deepseek-v4-flash"],
            failures: [],
          }),
        })
      ).json();
      assert.equal(simulated.selected.provider, "deepseek");
    });
  },
);

test(
  "every /api/v1/policy/* mutation route rejects a missing or wrong CSRF token",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const policyKey = `test-policy-csrf-${randomUUID().slice(0, 8)}`;
      const wrongToken = "wrong-token".padEnd(csrfSecret.length, "y");
      const mutatingRequests: Array<{
        path: string;
        body: Record<string, unknown>;
      }> = [
        {
          path: "/api/v1/policy/draft",
          body: { policyKey, policy: validRuntimePolicy },
        },
        {
          path: "/api/v1/policy/validate",
          body: { id: randomUUID(), expectedVersion: 1 },
        },
        {
          path: "/api/v1/policy/approve",
          body: { id: randomUUID(), expectedVersion: 1 },
        },
        {
          path: "/api/v1/policy/activate",
          body: { id: randomUUID(), expectedVersion: 1 },
        },
        {
          path: "/api/v1/policy/rollback",
          body: { policyKey, targetVersion: 1 },
        },
        {
          path: "/api/v1/policy/codex-override",
          body: {
            taskId: randomUUID(),
            reason: "csrf rejection probe",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      ];
      for (const { path, body } of mutatingRequests) {
        const noToken = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(noToken.status, 403, `${path} without token`);

        const wrongTokenResponse = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": wrongToken,
          },
          body: JSON.stringify(body),
        });
        assert.equal(
          wrongTokenResponse.status,
          403,
          `${path} with wrong token`,
        );
      }

      // /simulate is a read-only "what would happen" query (ADR-0003), not a
      // state mutation -- it deliberately has no CSRF gate, only requireOwner.
      // Confirm it stays reachable without a CSRF token (still requires
      // owner auth, proven by the cloudflare-mode test elsewhere) so this
      // test documents the boundary rather than accidentally asserting the
      // wrong thing about it.
      const simulateWithoutToken = await fetch(
        `${baseUrl}/api/v1/policy/simulate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            policyKey,
            taskClass: "bulk_code",
            taskId: randomUUID(),
            availableModelKeys: ["deepseek:deepseek-v4-flash"],
            failures: [],
          }),
        },
      );
      assert.notEqual(simulateWithoutToken.status, 403);
    });
  },
);

test(
  "serves the built dashboard SPA and falls back to index.html for client routes",
  { skip: databaseUrl === undefined },
  async () => {
    const dashboardDistPath = join(import.meta.dirname, "..", "dist-dashboard");
    if (!existsSync(join(dashboardDistPath, "index.html"))) {
      // dist-dashboard/ only exists after `npm run dashboard:build` -- skip
      // rather than fail if this test runs before a build has ever happened.
      return;
    }
    await withServer(
      "disabled",
      async (baseUrl) => {
        const index = await fetch(`${baseUrl}/`);
        assert.equal(index.status, 200);
        assert.match(await index.text(), /<html/i);

        // Express 5's router (path-to-regexp v8) rejects a bare "*" pattern
        // at startup -- this exact route caught that regression live before
        // it was covered here (createControlApi() must not throw, and an
        // unknown client-side path must still resolve to index.html).
        const clientRoute = await fetch(`${baseUrl}/orchestrator`);
        assert.equal(clientRoute.status, 200);
        assert.match(await clientRoute.text(), /<html/i);

        const api404 = await fetch(`${baseUrl}/api/v1/does-not-exist`);
        assert.equal(api404.status, 404);
      },
      dashboardDistPath,
    );
  },
);

test(
  "Telegram webhook: rejects a bad secret, accepts a valid Approve callback",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const config = loadConfig({
      NODE_ENV: "test",
      ACCESS_AUTH_MODE: "disabled",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret-for-tests",
      TELEGRAM_CHAT_ID: "-1001",
      TELEGRAM_USER_ID: "42",
      PROJECT_WORKSPACES_ROOT: mkdtempSync(
        join(tmpdir(), "control-api-workspaces-"),
      ),
    });
    const app = createControlApi({ pool, config, csrfSecret: "x".repeat(40) });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("server did not bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const { generateApprovalToken, hashApprovalToken } =
        await import("../src/approvals/token.js");
      const { PostgresApprovalRepository } =
        await import("../src/approvals/postgres-repository.js");
      const token = generateApprovalToken();
      const approvalId = randomUUID();
      await new PostgresApprovalRepository(pool).create({
        id: approvalId,
        target: {
          kind: "test",
          id: "t1",
          summary: "test approval",
          risk: "low",
          rollback: "n/a",
        },
        status: "pending",
        tokenHash: hashApprovalToken(token),
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      });

      const update = {
        callback_query: {
          data: `approve:${token}`,
          message: { chat: { id: -1001 } },
          from: { id: 42 },
        },
      };

      const badSecret = await fetch(`${baseUrl}/api/v1/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "wrong",
        },
        body: JSON.stringify(update),
      });
      assert.equal(badSecret.status, 401);

      const goodSecret = await fetch(`${baseUrl}/api/v1/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret-for-tests",
        },
        body: JSON.stringify(update),
      });
      assert.equal(goodSecret.status, 200);
      const result = await goodSecret.json();
      assert.equal(result.outcome, "decided");

      // The whole point of this milestone's dashboard work: a decision made
      // through the Telegram webhook must be observable from the dashboard
      // snapshot, not just from this endpoint's own response.
      const snapshot = await (
        await fetch(`${baseUrl}/api/v1/dashboard/snapshot`)
      ).json();
      const decided = snapshot.approvals.data.find(
        (a: { id: string }) => a.id === approvalId,
      );
      assert.ok(decided, "decided approval missing from snapshot");
      assert.equal(decided.state, "approved");
      assert.equal(decided.decidedBy, "42");
      assert.ok(typeof decided.decidedAt === "string");
      assert.equal(snapshot.telegram.data.webhookRegistered, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  },
);

test(
  "Telegram webhook route does not exist when TELEGRAM_WEBHOOK_SECRET is unset",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/telegram/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404);

      const snapshot = await (
        await fetch(`${baseUrl}/api/v1/dashboard/snapshot`)
      ).json();
      assert.equal(snapshot.telegram.data.webhookRegistered, false);
    });
  },
);
