import { config as loadDotEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { loadConfig } from "../config.js";
import { createControlApi } from "./app.js";

loadDotEnv({ quiet: true });
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });

// dist-dashboard/ is the Vite build output (npm run dashboard:build) --
// serve it if present so a single process can host both the API and the
// SPA; absent in local dev when only `vite` (dashboard:dev) is running.
const here = dirname(fileURLToPath(import.meta.url));
const dashboardDistPath = join(here, "..", "..", "dist-dashboard");

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
