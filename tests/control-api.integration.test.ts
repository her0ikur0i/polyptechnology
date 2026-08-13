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
import { PostgresReplyChunkStore } from "../src/orchestrator/reply-chunks.js";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import { PostgresPolicyStore } from "../src/policy/postgres-policy-store.js";
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
    ATTACHMENT_STORAGE_ROOT: mkdtempSync(
      join(tmpdir(), "control-api-attachments-"),
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
        {
          path: "/api/v1/orchestrator/conversations",
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
          path: "/api/v1/orchestrator/projects/00000000-0000-4000-8000-000000000000/conversations",
        },
        {
          path: "/api/v1/orchestrator/proposals/00000000-0000-4000-8000-000000000000",
        },
        {
          path: "/api/v1/orchestrator/reply-tasks/00000000-0000-4000-8000-000000000000/stream",
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

      // CONTRACT-015 M4: POST /policy/validate now fails closed without a
      // passing live-canary record for this exact policy content. Operationally
      // the owner gets that record by running scripts/policy-canary.ts with
      // POLICY_ID/POLICY_VERSION set; here it is written directly, because this
      // test is about the HTTP lifecycle and must not call real providers or
      // spend real money.
      const canaryPool = new pg.Pool({ connectionString: databaseUrl });
      try {
        await new PostgresPolicyStore(canaryPool).recordCanaryEvidence(
          draft.id,
          draft.version,
          "policy-canary",
          new Date(),
          [
            {
              provider: "deepseek",
              requestedModelId: "deepseek-v4-flash",
              ok: true,
              detail: "round-trip ok",
            },
          ],
        );
      } finally {
        await canaryPool.end();
      }

      // Refuses before the evidence exists is covered in
      // tests/policy-postgres.integration.test.ts; this asserts the happy path
      // still completes end to end through the API.
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

test(
  "starting a conversation with no projectId bootstraps a real idea-state project",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "My first idea",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();
      assert.match(started.conversationId, /^[a-f0-9-]{36}$/);
      assert.match(started.projectId, /^[a-f0-9-]{36}$/);
      assert.equal(started.title, "My first idea");
      assert.equal(started.version, 0);

      const snapshot = await (
        await fetch(`${baseUrl}/api/v1/dashboard/snapshot`)
      ).json();
      const bootstrapped = snapshot.projects.data.find(
        (p: { id: string }) => p.id === started.projectId,
      );
      // Overview's project view shows lifecycle -- a bootstrapped project
      // must stay "idea" (the placeholder blueprint is not a real one; see
      // src/operations/owner-commands.ts's startConversation() comment).
      assert.ok(bootstrapped, "bootstrapped project missing from snapshot");
      assert.equal(bootstrapped.lifecycle, "idea");
    });
  },
);

test(
  "a message round-trips through send, list, and conversation listing",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Invoice tracker idea",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();

      const sendResult = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              content: "I want to track vendor invoices.",
              expectedVersion: 0,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();
      const sent = sendResult.message;
      assert.equal(sent.ordinal, 1);
      assert.equal(sent.role, "owner");
      assert.equal(sent.classification, "internal");
      assert.match(sendResult.replyTaskId, /^[a-f0-9-]{36}$/);

      // The reply is queued as a real background task, not executed inline
      // -- no supervisor runs against this disposable database in this
      // test, so it must still be reachable and "queued", not silently
      // dropped.
      const replyStatus = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/reply-tasks/${sendResult.replyTaskId}`,
        )
      ).json();
      assert.equal(replyStatus.state, "queued");

      const noTokenCancel = await fetch(
        `${baseUrl}/api/v1/orchestrator/reply-tasks/${sendResult.replyTaskId}/cancel`,
        { method: "POST" },
      );
      assert.equal(noTokenCancel.status, 403);

      // Sending against the now-stale version must fail closed, not
      // silently accept a second message out of order.
      const stale = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: started.projectId,
            content: "second message, stale version",
            expectedVersion: 0,
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      assert.equal(stale.status, 400);

      const messages = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages?projectId=${started.projectId}`,
        )
      ).json();
      assert.equal(messages.length, 1);
      assert.equal(messages[0].id, sent.id);

      const list = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/projects/${started.projectId}/conversations`,
        )
      ).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, started.conversationId);
      assert.equal(list[0].version, 1);

      const cancelled = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/reply-tasks/${sendResult.replyTaskId}/cancel`,
          { method: "POST", headers },
        )
      ).json();
      assert.equal(cancelled.state, "cancelled");
      const cancelledAgain = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/reply-tasks/${sendResult.replyTaskId}/cancel`,
          { method: "POST", headers },
        )
      ).json();
      assert.equal(cancelledAgain.state, "cancelled");
    });
  },
);

test(
  "reply task SSE stream resumes after the requested chunk ordinal",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Streaming interview",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();
      const sendResult = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              content: "Stream this reply.",
              expectedVersion: 0,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();

      const streamPool = new pg.Pool({ connectionString: databaseUrl });
      try {
        const chunks = new PostgresReplyChunkStore(streamPool);
        await chunks.append({
          taskId: sendResult.replyTaskId,
          conversationId: started.conversationId,
          ordinal: 1,
          fragment: "alpha ",
        });
        await chunks.append({
          taskId: sendResult.replyTaskId,
          conversationId: started.conversationId,
          ordinal: 2,
          fragment: "beta",
        });
        const work = new PostgresWorkRepository(streamPool);
        const lease = await work.lease(
          sendResult.replyTaskId,
          "reply-stream-test",
          30_000,
        );
        await work.transition(
          sendResult.replyTaskId,
          lease.fencingToken,
          "leased",
          "running",
        );
        await work.transition(
          sendResult.replyTaskId,
          lease.fencingToken,
          "running",
          "verifying",
        );
        await work.transition(
          sendResult.replyTaskId,
          lease.fencingToken,
          "verifying",
          "succeeded",
        );
      } finally {
        await streamPool.end();
      }

      const response = await fetch(
        `${baseUrl}/api/v1/orchestrator/reply-tasks/${sendResult.replyTaskId}/stream?after=1`,
      );
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type") ?? "",
        /text\/event-stream/,
      );
      const body = await response.text();
      assert.doesNotMatch(body, /alpha/);
      assert.match(body, /event: chunk/);
      assert.match(body, /"ordinal":2/);
      assert.match(body, /beta/);
      assert.match(body, /event: done/);
      assert.match(body, /"state":"succeeded"/);
    });
  },
);

test(
  "reply task SSE stream caps concurrent readers for a nonterminal task",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Stream cap",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();
      const sendResult = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              content: "Keep this task queued.",
              expectedVersion: 0,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();
      const controllers = [
        new AbortController(),
        new AbortController(),
        new AbortController(),
      ];
      try {
        const responses = await Promise.all(
          controllers.map((controller) =>
            fetch(
              `${baseUrl}/api/v1/orchestrator/reply-tasks/${sendResult.replyTaskId}/stream`,
              { signal: controller.signal },
            ),
          ),
        );
        assert.deepEqual(
          responses.map((response) => response.status),
          [200, 200, 200],
        );
        const rejected = await fetch(
          `${baseUrl}/api/v1/orchestrator/reply-tasks/${sendResult.replyTaskId}/stream`,
        );
        assert.equal(rejected.status, 429);
      } finally {
        for (const controller of controllers) controller.abort();
        const cleanupPool = new pg.Pool({ connectionString: databaseUrl });
        try {
          await new PostgresWorkRepository(cleanupPool).controlTransition(
            sendResult.replyTaskId,
            "queued",
            "cancelled",
          );
        } finally {
          await cleanupPool.end();
        }
      }
    });
  },
);

test(
  "reply task cancel stops active work and invalidates stale worker fences",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const setupPool = new pg.Pool({ connectionString: databaseUrl });
      let taskId = "";
      let fencingToken = 0;
      let attemptOrdinal = 0;
      try {
        const work = new PostgresWorkRepository(setupPool);
        const contractId = randomUUID();
        const milestoneId = randomUUID();
        await setupPool.query(
          "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',$3)",
          [contractId, "0".repeat(40), 5_000_000],
        );
        await setupPool.query(
          "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
          [milestoneId, contractId],
        );
        const task = await work.submit({
          contractId,
          milestoneId,
          idempotencyKey: `active-cancel-${randomUUID()}`,
          maxCostUsdMicros: 5_000_000,
          maxAttempts: 3,
        });
        taskId = task.id;
        await setupPool.query(
          "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'conversation_reply',$2,NULL,'conversation-interview')",
          [taskId, { conversationId: randomUUID(), projectId: randomUUID() }],
        );
        await work.controlTransition(taskId, "draft", "queued");
        const lease = await work.lease(taskId, "test-worker", 60_000);
        fencingToken = lease.fencingToken;
        attemptOrdinal = lease.attemptOrdinal;
        await work.transition(taskId, fencingToken, "leased", "running");

        const cancelled = await (
          await fetch(
            `${baseUrl}/api/v1/orchestrator/reply-tasks/${taskId}/cancel`,
            { method: "POST", headers },
          )
        ).json();
        assert.equal(cancelled.state, "cancelled");

        await assert.rejects(
          work.transition(taskId, fencingToken, "running", "verifying"),
          /stale lease|invalid task state/,
        );
        const leaseRows = await setupPool.query(
          "SELECT 1 FROM task_leases WHERE task_id=$1",
          [taskId],
        );
        assert.equal(leaseRows.rowCount, 0);
        const attemptRows = await setupPool.query<{
          state: string;
          failure_reason: string | null;
          finished_at: Date | null;
        }>(
          "SELECT state,failure_reason,finished_at FROM task_attempts WHERE task_id=$1 AND ordinal=$2",
          [taskId, attemptOrdinal],
        );
        assert.equal(attemptRows.rows[0]?.state, "cancelled");
        assert.equal(attemptRows.rows[0]?.failure_reason, "worker");
        assert.notEqual(attemptRows.rows[0]?.finished_at, null);
      } finally {
        await setupPool.end();
      }
    });
  },
);

test(
  "starting a conversation on an existing project reuses it instead of bootstrapping a new one",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const first = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "First chat",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();

      const second = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Follow-up chat",
            projectId: first.projectId,
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();
      assert.equal(second.projectId, first.projectId);
      assert.notEqual(second.conversationId, first.conversationId);

      const list = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/projects/${first.projectId}/conversations`,
        )
      ).json();
      assert.equal(list.length, 2);
    });
  },
);

test(
  "conversation and message routes reject a missing CSRF token",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const noToken = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "x",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      assert.equal(noToken.status, 403);

      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfSecret,
          },
          body: JSON.stringify({
            title: "x",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();

      const noTokenMessage = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: started.projectId,
            content: "hi",
            expectedVersion: 0,
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      assert.equal(noTokenMessage.status, 403);

      // GET routes are read-only queries (ADR-0003) -- no CSRF gate, only
      // requireOwner, matching /api/v1/policy/simulate's precedent.
      const readWithoutToken = await fetch(
        `${baseUrl}/api/v1/orchestrator/projects/${started.projectId}/conversations`,
      );
      assert.notEqual(readWithoutToken.status, 403);
    });
  },
);

test(
  "attachment upload accepts an allowed type, rejects a disallowed type, an oversized file, and a missing CSRF token",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfSecret,
          },
          body: JSON.stringify({
            title: "Upload test",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();

      const allowedForm = new FormData();
      allowedForm.set("projectId", started.projectId);
      allowedForm.set(
        "file",
        new Blob(["a requirements note"], { type: "text/plain" }),
        "requirements.txt",
      );
      const accepted = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/attachments`,
        {
          method: "POST",
          headers: { "x-csrf-token": csrfSecret },
          body: allowedForm,
        },
      );
      assert.equal(accepted.status, 201, JSON.stringify(await accepted.json()));

      const disallowedForm = new FormData();
      disallowedForm.set("projectId", started.projectId);
      disallowedForm.set(
        "file",
        new Blob(["fake binary"], { type: "application/x-executable" }),
        "evil.exe",
      );
      const rejectedType = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/attachments`,
        {
          method: "POST",
          headers: { "x-csrf-token": csrfSecret },
          body: disallowedForm,
        },
      );
      assert.equal(rejectedType.status, 400);

      const oversizedForm = new FormData();
      oversizedForm.set("projectId", started.projectId);
      oversizedForm.set(
        "file",
        new Blob([new Uint8Array(26 * 1024 * 1024)], { type: "text/plain" }),
        "big.txt",
      );
      const rejectedSize = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/attachments`,
        {
          method: "POST",
          headers: { "x-csrf-token": csrfSecret },
          body: oversizedForm,
        },
      );
      // Real, previously-shipped bug: multer's own error handling reported
      // this as an unstructured HTML 500 rather than this route's clean
      // JSON error shape -- fixed by invoking the multer middleware
      // directly with its callback form instead of chaining it into the
      // route's middleware array (src/control-api/app.ts).
      assert.equal(rejectedSize.status, 400);
      const sizeBody = await rejectedSize.json();
      assert.ok(typeof sizeBody.error === "string");

      const noTokenForm = new FormData();
      noTokenForm.set("projectId", started.projectId);
      noTokenForm.set(
        "file",
        new Blob(["ok"], { type: "text/plain" }),
        "ok.txt",
      );
      const noToken = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/attachments`,
        { method: "POST", body: noTokenForm },
      );
      assert.equal(noToken.status, 403);

      const list = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/attachments?projectId=${started.projectId}`,
        )
      ).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].displayName, "requirements.txt");
      assert.equal(list[0].state, "scanned");
    });
  },
);

test(
  "a path-traversal-shaped filename can never escape storage: multer strips it to a basename, and the stored object key is always server-generated",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfSecret,
          },
          body: JSON.stringify({
            title: "Path traversal test",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();

      // Real finding while writing this test: the original expectation was
      // that validateAttachmentMetadata()'s '/'/'\0' check
      // (src/orchestrator/attachments.ts) would reject a traversal-shaped
      // name outright. Live testing showed multer/busboy's own
      // Content-Disposition filename parsing already reduces
      // "../../../../etc/passwd" and "..\\..\\windows\\system32\\config" to
      // their basenames ("passwd", "config") before this application ever
      // sees them -- a different, earlier defense layer than assumed. This
      // test asserts the real, verified behavior: displayName is always
      // reduced to a bare basename, and objectKey
      // (src/control-api/attachment-upload.ts) never derives from the
      // client-supplied name at all regardless -- both layers hold
      // independently.
      const cases: Array<[string, string]> = [
        ["../../../../etc/passwd", "passwd"],
        ["..\\..\\windows\\system32\\config", "config"],
      ];
      for (const [suppliedName, expectedBasename] of cases) {
        const form = new FormData();
        form.set("projectId", started.projectId);
        form.set(
          "file",
          new Blob(["irrelevant content"], { type: "text/plain" }),
          suppliedName,
        );
        const response = await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/attachments`,
          {
            method: "POST",
            headers: { "x-csrf-token": csrfSecret },
            body: form,
          },
        );
        const body = await response.json();
        assert.equal(response.status, 201, JSON.stringify(body));
        assert.equal(body.displayName, expectedBasename, suppliedName);
        assert.match(
          body.objectKey,
          new RegExp(`^${started.projectId}/[a-f0-9-]{36}$`),
        );
      }
    });
  },
);

async function cancelReplyTask(taskId: string) {
  // The reply task queued by sending a message is a real background task
  // (M2) -- ExecutableTaskSupervisor.runOne()'s eligible-task query has no
  // per-test scoping, so an uncancelled queued task is a landmine for
  // whichever other test's supervisor run happens to pick it up first
  // (hit for real during this contract's own live testing -- see M5
  // evidence). Cancel explicitly rather than leaving it behind.
  const cleanupPool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await new PostgresWorkRepository(cleanupPool).controlTransition(
      taskId,
      "queued",
      "cancelled",
    );
  } finally {
    await cleanupPool.end();
  }
}

test(
  "drafting a proposal requires a nonempty conversation, then approve+handoff freezes the candidate in one action",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Invoice tracker idea",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();

      const emptyDraft = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/proposals`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: started.projectId,
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      assert.equal(emptyDraft.status, 400);

      const sendResult = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              content: "I want a tool to track vendor invoices.",
              expectedVersion: 0,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();

      const draft = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/proposals`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();
      assert.equal(draft.state, "owner_review");
      assert.match(draft.contractCandidate, /vendor invoices/);

      const fetched = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}?projectId=${started.projectId}`,
        )
      ).json();
      assert.equal(fetched.state, "owner_review");
      assert.equal(fetched.version, draft.version);

      const handedOff = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}/approve`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              expectedVersion: draft.version,
            }),
          },
        )
      ).json();
      assert.match(handedOff.approvalId, /^[a-f0-9-]{36}$/);
      assert.equal(handedOff.contractCandidate, draft.contractCandidate);

      await cancelReplyTask(sendResult.replyTaskId);
    });
  },
);

test(
  "rejecting a proposal is terminal, and a stale-version approve fails closed",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Reject path",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();
      const sendResult = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              content: "Not sure this is worth pursuing.",
              expectedVersion: 0,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();
      const draft = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/proposals`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();

      const rejected = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}/reject`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              expectedVersion: draft.version,
            }),
          },
        )
      ).json();
      assert.equal(rejected.state, "rejected");

      const staleApprove = await fetch(
        `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}/approve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: started.projectId,
            expectedVersion: draft.version,
          }),
        },
      );
      assert.equal(staleApprove.status, 400);

      const noTokenDraft = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/proposals`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: started.projectId,
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        },
      );
      assert.equal(noTokenDraft.status, 403);

      await cancelReplyTask(sendResult.replyTaskId);
    });
  },
);

test(
  "translating a proposal is gated on it being handed off, then queues a real background task",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Translate gating",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();
      const sendResult = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              content: "A Node/Express/Postgres invoice tracker.",
              expectedVersion: 0,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();
      const draft = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/proposals`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              idempotencyKey: randomUUID(),
              occurredAt: new Date().toISOString(),
            }),
          },
        )
      ).json();

      const tooEarly = await fetch(
        `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}/translate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ projectId: started.projectId }),
        },
      );
      assert.equal(tooEarly.status, 400);

      await fetch(
        `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}/approve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: started.projectId,
            expectedVersion: draft.version,
          }),
        },
      );

      const queued = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}/translate`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ projectId: started.projectId }),
          },
        )
      ).json();
      assert.match(queued.taskId, /^[a-f0-9-]{36}$/);

      const status = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/reply-tasks/${queued.taskId}`,
        )
      ).json();
      assert.equal(status.state, "queued");

      const noToken = await fetch(
        `${baseUrl}/api/v1/orchestrator/proposals/${draft.proposalId}/translate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: started.projectId }),
        },
      );
      assert.equal(noToken.status, 403);

      await cancelReplyTask(sendResult.replyTaskId);
      await cancelReplyTask(queued.taskId);
    });
  },
);

test(
  "rename, archive, unarchive, and search all round-trip through the real store",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer("disabled", async (baseUrl, csrfSecret) => {
      const headers = {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
      };
      const started = await (
        await fetch(`${baseUrl}/api/v1/orchestrator/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Invoice ideas",
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        })
      ).json();

      const renamed = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/rename`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              title: "Vendor invoice tracker (renamed)",
              expectedVersion: 0,
            }),
          },
        )
      ).json();
      assert.equal(renamed.title, "Vendor invoice tracker (renamed)");
      assert.equal(renamed.version, 1);

      // A stale-version rename must fail closed, not silently overwrite.
      const staleRename = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/rename`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: started.projectId,
            title: "Should not apply",
            expectedVersion: 0,
          }),
        },
      );
      assert.equal(staleRename.status, 400);

      const archived = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/archive`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              archived: true,
              expectedVersion: 1,
            }),
          },
        )
      ).json();
      assert.ok(archived.archivedAt);

      const defaultList = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/projects/${started.projectId}/conversations`,
        )
      ).json();
      assert.equal(defaultList.length, 0);

      const withArchived = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/projects/${started.projectId}/conversations?includeArchived=true`,
        )
      ).json();
      assert.equal(withArchived.length, 1);
      assert.equal(withArchived[0].id, started.conversationId);

      const unarchived = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/archive`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: started.projectId,
              archived: false,
              expectedVersion: 2,
            }),
          },
        )
      ).json();
      assert.equal(unarchived.archivedAt, undefined);

      const matchingSearch = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/projects/${started.projectId}/conversations?search=invoice`,
        )
      ).json();
      assert.equal(matchingSearch.length, 1);

      const nonMatchingSearch = await (
        await fetch(
          `${baseUrl}/api/v1/orchestrator/projects/${started.projectId}/conversations?search=zzz`,
        )
      ).json();
      assert.equal(nonMatchingSearch.length, 0);

      const noTokenRename = await fetch(
        `${baseUrl}/api/v1/orchestrator/conversations/${started.conversationId}/rename`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: started.projectId,
            title: "x",
            expectedVersion: 3,
          }),
        },
      );
      assert.equal(noTokenRename.status, 403);
    });
  },
);
