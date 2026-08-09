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

test("cloudflare mode refuses a non-loopback bind address", () => {
  assert.throws(
    () =>
      loadConfig({
        ACCESS_AUTH_MODE: "cloudflare",
        HOST: "0.0.0.0",
      }),
    /loopback/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        ACCESS_AUTH_MODE: "cloudflare",
        HOST: "0.0.0.0",
        TELEGRAM_BOT_TOKEN: "test",
        TELEGRAM_CHAT_ID: "chat",
        TELEGRAM_USER_ID: "user",
        CSRF_SECRET: "x".repeat(32),
      }),
    /loopback/,
  );
});

test("cloudflare mode allows a non-loopback bind only with the explicit trust-boundary escape hatch", () => {
  const config = loadConfig({
    ACCESS_AUTH_MODE: "cloudflare",
    HOST: "0.0.0.0",
    CLOUDFLARE_TRUST_NETWORK_BOUNDARY: "true",
  });
  assert.equal(config.host, "0.0.0.0");
});

test("cloudflare mode accepts every loopback spelling", () => {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    const config = loadConfig({ ACCESS_AUTH_MODE: "cloudflare", HOST: host });
    assert.equal(config.host, host);
  }
});

test("disabled mode is unaffected by the loopback restriction", () => {
  const config = loadConfig({ ACCESS_AUTH_MODE: "disabled", HOST: "0.0.0.0" });
  assert.equal(config.host, "0.0.0.0");
});
