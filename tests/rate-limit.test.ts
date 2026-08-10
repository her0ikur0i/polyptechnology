import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createControlApi } from "../src/control-api/app.js";
import { loadConfig } from "../src/config.js";

// No query is ever issued: every request in this file is rejected by the
// limiter or by requireOwner, both of which run before any route handler
// touches the database. Constructing a Pool does not connect.
const idlePool = () =>
  new pg.Pool({ connectionString: "postgresql://unused@127.0.0.1:1/none" });

async function withServer(
  env: NodeJS.ProcessEnv,
  run: (origin: string) => Promise<void>,
) {
  const pool = idlePool();
  const app = createControlApi({
    pool,
    config: loadConfig({
      NODE_ENV: "test",
      CSRF_SECRET: "x".repeat(32),
      ...env,
    }),
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

test("api requests are throttled only after the configured ceiling", async () => {
  // 30 is the configured floor, not an arbitrary choice: config.ts refuses
  // anything lower, because a ceiling that can be set near zero is a lockout
  // waiting to happen. Asserted directly in "the ceilings are configurable and
  // validated" below.
  await withServer({ API_RATE_LIMIT_PER_MINUTE: "30" }, async (origin) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 32; attempt++) {
      const response = await fetch(`${origin}/api/v1/dashboard/snapshot`);
      statuses.push(response.status);
    }

    // What matters is that the limiter passed the first thirty through to the
    // rest of the stack, whatever that stack then decided. Asserting the exact
    // downstream status would be testing requireOwner, not the throttle.
    assert.equal(
      statuses.slice(0, 30).includes(429),
      false,
      "requests within the ceiling must not be throttled",
    );
    assert.deepEqual(statuses.slice(30), [429, 429]);
  });
});

test("throttling does not reach static assets or the SPA fallback", async () => {
  await withServer({ API_RATE_LIMIT_PER_MINUTE: "30" }, async (origin) => {
    for (let attempt = 0; attempt < 30; attempt++)
      await fetch(`${origin}/api/v1/dashboard/snapshot`);

    // API budget is now exhausted...
    assert.equal(
      (await fetch(`${origin}/api/v1/dashboard/snapshot`)).status,
      429,
    );
    // ...but a non-API path is unaffected. 404 here because no dashboard dist
    // path is configured in this test; the point is that it is not 429.
    assert.equal((await fetch(`${origin}/`)).status, 404);
  });
});

test("the Telegram webhook keeps a budget separate from the owner's", async () => {
  await withServer({ API_RATE_LIMIT_PER_MINUTE: "30" }, async (origin) => {
    for (let attempt = 0; attempt < 31; attempt++)
      await fetch(`${origin}/api/v1/dashboard/snapshot`);
    assert.equal(
      (await fetch(`${origin}/api/v1/dashboard/snapshot`)).status,
      429,
    );

    // Both arrive through the same tunnel and so often share a client address.
    // Inbound Telegram traffic must not be able to exhaust the owner's
    // allowance, nor the owner's dashboard use the webhook's. 404 because the
    // route is not registered without Telegram configuration -- the assertion
    // that matters is that it is not 429.
    const webhook = await fetch(`${origin}/api/v1/telegram/webhook`, {
      method: "POST",
    });
    assert.equal(webhook.status, 404);
  });
});

test("the webhook's own ceiling is enforced independently", async () => {
  await withServer(
    {
      WEBHOOK_RATE_LIMIT_PER_MINUTE: "10",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
      TELEGRAM_CHAT_ID: "-1001",
      TELEGRAM_USER_ID: "1001",
      TELEGRAM_BOT_TOKEN: "t".repeat(20),
    },
    async (origin) => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await fetch(`${origin}/api/v1/telegram/webhook`, {
          method: "POST",
          headers: {
            "x-telegram-bot-api-secret-token": "s".repeat(32),
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        });
        statuses.push(response.status);
      }
      // The ceiling governs authenticated Telegram traffic. Requests carrying a
      // valid secret pass through to the handler until the budget runs out;
      // the last two are throttled. Before the M8 review this assertion was
      // written against *unauthenticated* requests, which is exactly the flaw
      // that review found: rejected traffic was spending Telegram's budget.
      assert.equal(statuses.filter((status) => status === 429).length, 2);
      assert.equal(statuses.slice(0, 10).includes(429), false);
    },
  );
});

test("the case of the request path cannot skip the limiter", async () => {
  // CONTRACT-015 M8's CRITICAL finding, shipped broken by M3. Express matches
  // routes case-insensitively unless "case sensitive routing" is enabled, which
  // this app never enables -- so a case-sensitive dispatch check disagreed with
  // the router about which requests exist, and /API/v1/... reached the real
  // handler with no throttle at all. The limiter protecting the AI budget could
  // be skipped by holding down shift.
  await withServer({ API_RATE_LIMIT_PER_MINUTE: "30" }, async (origin) => {
    for (let attempt = 0; attempt < 31; attempt++)
      await fetch(`${origin}/api/v1/dashboard/snapshot`);

    for (const variant of [
      "/api/v1/dashboard/snapshot",
      "/API/v1/dashboard/snapshot",
      "/Api/V1/Dashboard/Snapshot",
      "/API/V1/DASHBOARD/SNAPSHOT",
    ])
      assert.equal(
        (await fetch(`${origin}${variant}`)).status,
        429,
        `${variant} escaped the limiter`,
      );
  });
});

test("an unauthenticated caller cannot spend the webhook's real budget", async () => {
  // Also from the M8 review. The webhook is the one route reachable without
  // Cloudflare Access, because Telegram cannot do interactive SSO. Previously
  // the limiter ran before the secret check, so anyone who knew the fixed path
  // could hold the protective budget at zero with rejected requests and deny
  // the owner's real approval callbacks -- a credential-free DoS on the
  // approval channel. The configured ceiling is now consumed only after the
  // secret validates; anonymous traffic is held by a separate, looser guard.
  const secret = "s".repeat(32);
  await withServer(
    {
      WEBHOOK_RATE_LIMIT_PER_MINUTE: "10",
      TELEGRAM_WEBHOOK_SECRET: secret,
      TELEGRAM_CHAT_ID: "-1001",
      TELEGRAM_USER_ID: "1001",
      TELEGRAM_BOT_TOKEN: "t".repeat(20),
    },
    async (origin) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const rejectedCall = await fetch(`${origin}/api/v1/telegram/webhook`, {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "wrong" },
        });
        assert.equal(
          rejectedCall.status,
          401,
          "an unauthenticated caller must be refused, not throttled",
        );
      }

      // Twelve rejected attempts, against a configured ceiling of ten. If they
      // had consumed the authenticated budget this would now be 429.
      const authenticated = await fetch(`${origin}/api/v1/telegram/webhook`, {
        method: "POST",
        headers: {
          "x-telegram-bot-api-secret-token": secret,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.notEqual(
        authenticated.status,
        429,
        "unauthenticated traffic consumed Telegram's budget",
      );
    },
  );
});

test("the default ceiling sits far above the dashboard's own polling", () => {
  const config = loadConfig({ NODE_ENV: "test", CSRF_SECRET: "x".repeat(32) });
  // src/dashboard/conversation-workspace.tsx polls a pending reply every
  // 1500 ms, i.e. about 40 requests a minute. A default that did not clear
  // that by a wide margin would throttle the owner during ordinary use, which
  // is the specific failure this contract's gate forbids.
  const pollerRequestsPerMinute = 60_000 / 1500;
  assert.equal(config.apiRateLimitPerMinute, 300);
  assert.ok(config.apiRateLimitPerMinute > pollerRequestsPerMinute * 5);
  assert.equal(config.webhookRateLimitPerMinute, 60);
});

test("the ceilings are configurable and validated", () => {
  const raised = loadConfig({
    NODE_ENV: "test",
    CSRF_SECRET: "x".repeat(32),
    API_RATE_LIMIT_PER_MINUTE: "5000",
  });
  assert.equal(raised.apiRateLimitPerMinute, 5000);

  // A throttle that can be set to zero is a lockout waiting to happen.
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        CSRF_SECRET: "x".repeat(32),
        API_RATE_LIMIT_PER_MINUTE: "0",
      }),
    /API_RATE_LIMIT_PER_MINUTE must be between 30 and 100000/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        CSRF_SECRET: "x".repeat(32),
        WEBHOOK_RATE_LIMIT_PER_MINUTE: "not-a-number",
      }),
    /WEBHOOK_RATE_LIMIT_PER_MINUTE must be an integer/,
  );
});
