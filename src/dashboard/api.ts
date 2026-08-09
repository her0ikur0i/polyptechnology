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
export async function generateProject(
  projectId: string,
  csrfToken: string,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9-]{36}$/.test(projectId))
    throw new Error("Invalid project id.");
  return commandRequest<{
    taskId: string;
    contractId: string;
    milestoneId: string;
  }>(`/api/v1/factory/projects/${projectId}/generate`, {}, csrfToken, signal);
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
export interface ConversationProposal {
  id: string;
  conversationId: string;
  projectId: string;
  version: number;
  state: string;
  contractCandidate: string;
  candidateSha256: string;
  approvalId?: string;
}
export async function draftProposal(
  conversationId: string,
  command: { projectId: string },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<{
    proposalId: string;
    conversationId: string;
    state: string;
    version: number;
    contractCandidate: string;
  }>(
    `/api/v1/orchestrator/conversations/${conversationId}/proposals`,
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    signal,
  );
}
export async function approveProposal(
  proposalId: string,
  command: { projectId: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<{
    proposalId: string;
    projectId: string;
    conversationId: string;
    approvalId: string;
    contractCandidate: string;
    candidateSha256: string;
  }>(
    `/api/v1/orchestrator/proposals/${proposalId}/approve`,
    command,
    csrfToken,
    signal,
  );
}
export async function rejectProposal(
  proposalId: string,
  command: { projectId: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<ConversationProposal>(
    `/api/v1/orchestrator/proposals/${proposalId}/reject`,
    command,
    csrfToken,
    signal,
  );
}
export async function getProposal(
  proposalId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ConversationProposal | undefined> {
  const response = await fetch(
    `/api/v1/orchestrator/proposals/${proposalId}?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new DashboardApiError(response.status, "Proposal is unavailable.");
  return response.json();
}
export async function translateProposal(
  proposalId: string,
  command: { projectId: string },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<{ taskId: string }>(
    `/api/v1/orchestrator/proposals/${proposalId}/translate`,
    command,
    csrfToken,
    signal,
  );
}
export interface ConversationSummary {
  id: string;
  projectId: string;
  title: string;
  version: number;
  createdAt: string;
  archivedAt?: string;
}
export interface ConversationMessage {
  id: string;
  conversationId: string;
  projectId: string;
  ordinal: number;
  role: "owner" | "assistant" | "system";
  content: string;
  classification: string;
  contentSha256: string;
  createdAt: string;
}
export interface ConversationAttachment {
  id: string;
  conversationId: string;
  projectId: string;
  objectKey: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  state: string;
  classification?: string;
}
export async function startConversation(
  command: { title: string; projectId?: string },
  csrfToken: string,
  signal?: AbortSignal,
) {
  if (command.title.trim().length < 1)
    throw new Error("Conversation title is required.");
  return commandRequest<{
    conversationId: string;
    projectId: string;
    title: string;
    version: number;
  }>(
    "/api/v1/orchestrator/conversations",
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    signal,
  );
}
export async function sendConversationMessage(
  conversationId: string,
  command: { projectId: string; content: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  if (command.content.trim().length < 1)
    throw new Error("Message cannot be empty.");
  return commandRequest<{
    message: ConversationMessage;
    replyTaskId: string;
  }>(
    `/api/v1/orchestrator/conversations/${conversationId}/messages`,
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    signal,
  );
}
export async function listConversationMessages(
  conversationId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ConversationMessage[]> {
  const response = await fetch(
    `/api/v1/orchestrator/conversations/${conversationId}/messages?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok)
    throw new DashboardApiError(response.status, "Messages are unavailable.");
  return response.json();
}
export async function listProjectConversations(
  projectId: string,
  options?: { search?: string; includeArchived?: boolean },
  signal?: AbortSignal,
): Promise<ConversationSummary[]> {
  const params = new URLSearchParams();
  if (options?.search) params.set("search", options.search);
  if (options?.includeArchived) params.set("includeArchived", "true");
  const query = params.toString();
  const response = await fetch(
    `/api/v1/orchestrator/projects/${projectId}/conversations${query ? `?${query}` : ""}`,
    {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok)
    throw new DashboardApiError(
      response.status,
      "Conversations are unavailable.",
    );
  return response.json();
}
export async function renameConversation(
  conversationId: string,
  command: { projectId: string; title: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  return commandRequest<ConversationSummary>(
    `/api/v1/orchestrator/conversations/${conversationId}/rename`,
    command,
    csrfToken,
    signal,
  );
}
export async function setConversationArchived(
  conversationId: string,
  command: {
    projectId: string;
    archived: boolean;
    expectedVersion: number;
  },
  csrfToken: string,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  return commandRequest<ConversationSummary>(
    `/api/v1/orchestrator/conversations/${conversationId}/archive`,
    command,
    csrfToken,
    signal,
  );
}
export async function getReplyTaskStatus(
  taskId: string,
  signal?: AbortSignal,
): Promise<{ taskId: string; state: string }> {
  const response = await fetch(`/api/v1/orchestrator/reply-tasks/${taskId}`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new DashboardApiError(
      response.status,
      "Reply status is unavailable.",
    );
  return response.json();
}
export async function uploadConversationAttachment(
  conversationId: string,
  projectId: string,
  file: File,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<ConversationAttachment> {
  const form = new FormData();
  form.set("projectId", projectId);
  form.set("file", file);
  const response = await fetch(
    `/api/v1/orchestrator/conversations/${conversationId}/attachments`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrfToken },
      body: form,
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const message =
      body !== undefined &&
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : "Upload failed.";
    throw new DashboardApiError(response.status, message);
  }
  return response.json();
}
export async function listConversationAttachments(
  conversationId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ConversationAttachment[]> {
  const response = await fetch(
    `/api/v1/orchestrator/conversations/${conversationId}/attachments?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok)
    throw new DashboardApiError(
      response.status,
      "Attachments are unavailable.",
    );
  return response.json();
}
export interface PolicyStateResult {
  id: string;
  version: number;
  state: string;
}
export async function createPolicyDraft(
  command: { policyKey: string; policy: unknown },
  csrfToken: string,
  signal?: AbortSignal,
) {
  if (command.policyKey.trim().length < 1)
    throw new Error("Policy key is required.");
  return commandRequest<PolicyStateResult>(
    "/api/v1/policy/draft",
    command,
    csrfToken,
    signal,
  );
}
export async function validatePolicyDraft(
  command: { id: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<PolicyStateResult>(
    "/api/v1/policy/validate",
    command,
    csrfToken,
    signal,
  );
}
export async function approvePolicyDraft(
  command: { id: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<PolicyStateResult>(
    "/api/v1/policy/approve",
    command,
    csrfToken,
    signal,
  );
}
export async function activatePolicyDraft(
  command: { id: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<PolicyStateResult>(
    "/api/v1/policy/activate",
    command,
    csrfToken,
    signal,
  );
}
export async function rollbackPolicy(
  command: { policyKey: string; targetVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<PolicyStateResult>(
    "/api/v1/policy/rollback",
    command,
    csrfToken,
    signal,
  );
}
export async function createCodexOverride(
  command: { taskId: string; reason: string; expiresAt: string },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest<{ id: string; taskId: string; expiresAt: string }>(
    "/api/v1/policy/codex-override",
    command,
    csrfToken,
    signal,
  );
}
export async function loadActivePolicy(
  policyKey: string,
  signal?: AbortSignal,
): Promise<
  { id: string; version: number; state: string; policy: unknown } | undefined
> {
  const response = await fetch(
    `/api/v1/policy/${encodeURIComponent(policyKey)}/active`,
    {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new DashboardApiError(
      response.status,
      "Active policy is unavailable.",
    );
  return response.json();
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
