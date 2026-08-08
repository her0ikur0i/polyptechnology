import type {
  DashboardSnapshot,
  TelegramSettings,
  TelegramSettingsCommand,
} from "./types.js";
import { parseDashboardSnapshot } from "./validation.js";
export class DashboardApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function loadDashboardSnapshot(
  signal?: AbortSignal,
): Promise<DashboardSnapshot> {
  const response = await fetch("/api/v1/dashboard/snapshot", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new DashboardApiError(
      response.status,
      response.status === 401 || response.status === 403
        ? "Owner authentication is required."
        : "Dashboard data is unavailable.",
    );
  return parseDashboardSnapshot(await response.json());
}
export async function saveTelegramSettings(
  command: TelegramSettingsCommand,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<TelegramSettings> {
  if (
    !/^secret:\/\/[a-zA-Z0-9/_-]+$/.test(command.secretRef) ||
    !command.authorizedChatIds.every((value) => /^-?[0-9]+$/.test(value)) ||
    !command.authorizedUserIds.every((value) => /^[0-9]+$/.test(value))
  )
    throw new Error(
      "Telegram settings contain invalid references or identities.",
    );
  const response = await fetch("/api/v1/settings/telegram", {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(command),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new DashboardApiError(
      response.status,
      response.status === 401 || response.status === 403
        ? "The settings command was not authorized."
        : "Telegram settings were not saved.",
    );
  return response.json() as Promise<TelegramSettings>;
}
