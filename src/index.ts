import { config as loadDotEnv } from "dotenv";
import { loadConfig } from "./config.js";

loadDotEnv({ quiet: true });
const config = loadConfig();

console.log(
  JSON.stringify({
    event: "polyp.foundation.ready",
    environment: config.environment,
    host: config.host,
    port: config.port,
    authMode: config.accessAuthMode,
  }),
);
