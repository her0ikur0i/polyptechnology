import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loads safe development defaults", () => {
  const config = loadConfig({});
  assert.equal(config.environment, "development");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.accessAuthMode, "disabled");
});

test("production fails closed without access authentication", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", ACCESS_AUTH_MODE: "disabled" }),
    /cannot be disabled/,
  );
});

test("production accepts Cloudflare Access mode", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    ACCESS_AUTH_MODE: "cloudflare",
    TELEGRAM_BOT_TOKEN: "test",
    TELEGRAM_CHAT_ID: "chat",
    TELEGRAM_USER_ID: "user",
    CSRF_SECRET: "x".repeat(32),
  });
  assert.equal(config.accessAuthMode, "cloudflare");
});

test("production fails closed without Telegram identity restrictions", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        ACCESS_AUTH_MODE: "cloudflare",
        CSRF_SECRET: "x".repeat(32),
      }),
    /TELEGRAM_USER_ID/,
  );
});

test("production fails closed without a real CSRF secret", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        ACCESS_AUTH_MODE: "cloudflare",
        TELEGRAM_BOT_TOKEN: "test",
        TELEGRAM_CHAT_ID: "chat",
        TELEGRAM_USER_ID: "user",
      }),
    /CSRF_SECRET/,
  );
});

test("development generates an ephemeral CSRF secret when unset", () => {
  const config = loadConfig({});
  assert.equal(config.csrfSecret.length >= 32, true);
});

test("rejects invalid ports and proxy hop counts", () => {
  assert.throws(() => loadConfig({ PORT: "0" }), /between/);
  assert.throws(() => loadConfig({ TRUSTED_PROXY_HOPS: "many" }), /integer/);
});
