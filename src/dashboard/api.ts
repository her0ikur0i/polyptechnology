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
export interface FactoryProjectCommand {
  slug: string;
  displayName: string;
  runtime: string;
  framework: string;
  database: string;
  requirements: ReadonlyArray<string>;
}
export async function createFactoryProject(
  command: FactoryProjectCommand,
  csrfToken: string,
  signal?: AbortSignal,
) {
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(command.slug) ||
    command.displayName.trim().length < 1 ||
    command.requirements.length < 1
  )
    throw new Error("Project blueprint is incomplete.");
  return commandRequest<{
    projectId: string;
    state: string;
    repositoryRef: string;
  }>(
    "/api/v1/factory/projects",
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    signal,
  );
}
export async function createConversationProposal(
  command: { projectId: string; title: string; objective: string },
  csrfToken: string,
  signal?: AbortSignal,
) {
  if (
    !/^[a-f0-9-]{36}$/.test(command.projectId) ||
    command.title.trim().length < 1 ||
    command.objective.trim().length < 10
  )
    throw new Error("Conversation proposal is incomplete.");
  return commandRequest<{
    conversationId: string;
    proposalId: string;
    state: string;
  }>(
    "/api/v1/orchestrator/proposals",
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    signal,
  );
}
async function commandRequest<T>(
  path: string,
  command: unknown,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
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
        ? "Owner authorization is required."
        : "The command was not accepted.",
    );
  return response.json() as Promise<T>;
}
