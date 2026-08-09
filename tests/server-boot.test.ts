import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");
const dashboardDistPath = join(repoRoot, "dist-dashboard");

// A real, previously-shipped bug: server.ts resolved dashboard-dist-path
// relative to import.meta.url (2 levels up from the running file). That is
// correct in dev (src/control-api/server.ts is 2 levels below the repo
// root) but wrong once compiled -- dist/src/control-api/server.js is only 2
// levels above dist/, not the repo root, since tsc mirrors the full
// "src/..." path under dist/. The bug silently downgraded to
// servingDashboard:false rather than crashing, so only booting the real
// process (dev form here, close enough to prove the fix generalizes) proves
// this, matching the CONTRACT-012 lesson: run the real server as a live
// process at least once per milestone, don't rely on integration tests that
// inject dashboardDistPath directly and never exercise this resolution.
test(
  "the real server process reports servingDashboard:true when dist-dashboard exists",
  { skip: !existsSync(dashboardDistPath) },
  async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/control-api/server.ts"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: "development",
          ACCESS_AUTH_MODE: "disabled",
          // config.ts rejects PORT=0 (not "let the OS pick"); a
          // high, unlikely-to-collide fixed port is simplest here.
          PORT: "48173",
          DATABASE_URL:
            process.env.TEST_DATABASE_URL ??
            "postgresql://polyp@127.0.0.1:5432/polyp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const ready = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          let buffer = "";
          const timeout = setTimeout(() => {
            reject(new Error(`server did not report ready: ${buffer}`));
          }, 15_000);
          child.stdout!.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            for (const line of buffer.split("\n")) {
              try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (parsed.event === "control-api.ready") {
                  clearTimeout(timeout);
                  resolve(parsed);
                  return;
                }
              } catch {
                // not a JSON line yet, keep buffering
              }
            }
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            reject(
              new Error(`server exited early with code ${code}: ${buffer}`),
            ),
          );
        },
      );
      assert.equal(ready.servingDashboard, true, JSON.stringify(ready));
    } finally {
      child.kill("SIGTERM");
    }
  },
);
