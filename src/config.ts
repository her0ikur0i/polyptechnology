export type Environment = "development" | "test" | "production";
export type AccessAuthMode = "disabled" | "cloudflare";

export interface AppConfig {
  environment: Environment;
  host: string;
  port: number;
  databaseUrl: string;
  accessAuthMode: AccessAuthMode;
  trustedProxyHops: number;
  logLevel: "debug" | "info" | "warn" | "error";
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramUserId?: string;
}

function enumValue<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function integer(name: string, value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = enumValue("NODE_ENV", env.NODE_ENV ?? "development", ["development", "test", "production"] as const);
  const accessAuthMode = enumValue("ACCESS_AUTH_MODE", env.ACCESS_AUTH_MODE ?? "disabled", ["disabled", "cloudflare"] as const);
  if (environment === "production" && accessAuthMode === "disabled") {
    throw new Error("ACCESS_AUTH_MODE cannot be disabled in production");
  }
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = env.TELEGRAM_CHAT_ID;
  const telegramUserId = env.TELEGRAM_USER_ID;
  if (environment === "production" && [telegramBotToken, telegramChatId, telegramUserId].some((value) => value === undefined || value.length === 0)) {
    throw new Error("production requires TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TELEGRAM_USER_ID");
  }

  return {
    environment,
    host: env.HOST ?? "127.0.0.1",
    port: integer("PORT", env.PORT ?? "4173", 1, 65535),
    databaseUrl: env.DATABASE_URL ?? "postgresql://polyp@127.0.0.1:5432/polyp",
    accessAuthMode,
    trustedProxyHops: integer("TRUSTED_PROXY_HOPS", env.TRUSTED_PROXY_HOPS ?? "0", 0, 8),
    logLevel: enumValue("LOG_LEVEL", env.LOG_LEVEL ?? "info", ["debug", "info", "warn", "error"] as const),
    ...(telegramBotToken === undefined ? {} : { telegramBotToken }),
    ...(telegramChatId === undefined ? {} : { telegramChatId }),
    ...(telegramUserId === undefined ? {} : { telegramUserId }),
  };
}
