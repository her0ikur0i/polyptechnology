import { config as loadDotEnv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadConfig } from "../config.js";
import { createControlApi } from "./app.js";

loadDotEnv({ quiet: true });
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });

// dist-dashboard/ is the Vite build output (npm run dashboard:build) --
// serve it if present so a single process can host both the API and the
// SPA; absent in local dev when only `vite` (dashboard:dev) is running.
// Resolved from process.cwd(), not import.meta.url: tsc's compiled output
// mirrors the full "src/..." path under dist/ (dist/src/control-api/server.js
// is only 2 levels above dist/, not the project root, unlike
// src/control-api/server.ts which *is* 2 levels below the project root in
// dev) -- cwd is the one thing that's consistently the project/release root
// in both `npm start` (repo root) and the systemd unit
// (WorkingDirectory=<release>), so it doesn't have this depth mismatch.
const dashboardDistPath = join(process.cwd(), "dist-dashboard");

const app = createControlApi({
  pool,
  config,
  ...(existsSync(dashboardDistPath) ? { dashboardDistPath } : {}),
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      event: "control-api.ready",
      host: config.host,
      port: config.port,
      accessAuthMode: config.accessAuthMode,
      servingDashboard: existsSync(dashboardDistPath),
    }),
  );
});

async function shutdown(signal: string) {
  console.log(JSON.stringify({ event: "control-api.shutdown", signal }));
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
