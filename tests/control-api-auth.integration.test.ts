import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { createControlApi } from "../src/control-api/app.js";
import { loadConfig } from "../src/config.js";
import { SESSION_COOKIE } from "../src/control-api/session.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const config = loadConfig({
    ...process.env,
    ACCESS_AUTH_MODE: "password",
    OWNER_PASSWORD: "test-password-123",
    NODE_ENV: "test",
    PROJECT_WORKSPACES_ROOT: mkdtempSync(join(tmpdir(), "auth-workspaces-")),
    ATTACHMENT_STORAGE_ROOT: mkdtempSync(join(tmpdir(), "auth-attachments-")),
  });
  const csrfSecret = "test-csrf-secret-".padEnd(40, "x");
  const app = createControlApi({ pool, config, csrfSecret });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("server did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

test(
  "password mode rejects unauthenticated requests and admits the owner",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer(async (baseUrl) => {
      const unauthenticated = await fetch(
        `${baseUrl}/api/v1/dashboard/snapshot`,
      );
      assert.equal(unauthenticated.status, 401);

      const wrong = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      assert.equal(wrong.status, 401);

      const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test-password-123" }),
      });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get("set-cookie") ?? "";
      assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);

      const cookie = setCookie.split(";")[0]!;
      const authenticated = await fetch(
        `${baseUrl}/api/v1/dashboard/snapshot`,
        { headers: { cookie } },
      );
      assert.equal(authenticated.status, 200);
    });
  },
);

test(
  "the login page is served publicly in password mode",
  { skip: databaseUrl === undefined },
  async () => {
    await withServer(async (baseUrl) => {
      const page = await fetch(`${baseUrl}/login`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Owner sign-in/);
    });
  },
);
