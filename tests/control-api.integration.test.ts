import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { createControlApi } from "../src/control-api/app.js";
import { loadConfig } from "../src/config.js";
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
