import type {
  DashboardSnapshot,
  TelegramSettings,
  TelegramSettingsCommand,
} from "./types.js";
import {
  parseActivePolicy,
  parseCodexOverrideResult,
  parseConversationAttachment,
  parseConversationAttachmentList,
  parseConversationMessageList,
  parseConversationProposal,
  parseConversationStartResult,
  parseConversationSummary,
  parseConversationSummaryList,
  parseDashboardSnapshot,
  parseFactoryProjectResult,
  parseGenerationTaskResult,
  parsePolicyStateResult,
  parseProposalApprovalResult,
  parseProposalCreationResult,
  parseProposalDraftResult,
  parseReplyStreamChunk,
  parseReplyStreamDone,
  parseReplyTaskStatus,
  parseSendMessageResult,
  parseTelegramSettings,
  parseTranslationTaskResult,
} from "./validation.js";
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
  return parseTelegramSettings(await response.json());
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
  return commandRequest(
    "/api/v1/factory/projects",
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    parseFactoryProjectResult,
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
  return commandRequest(
    `/api/v1/factory/projects/${projectId}/generate`,
    {},
    csrfToken,
    parseGenerationTaskResult,
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
  return commandRequest(
    "/api/v1/orchestrator/proposals",
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    parseProposalCreationResult,
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
  return commandRequest(
    `/api/v1/orchestrator/conversations/${conversationId}/proposals`,
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    parseProposalDraftResult,
    signal,
  );
}
export async function approveProposal(
  proposalId: string,
  command: { projectId: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    `/api/v1/orchestrator/proposals/${proposalId}/approve`,
    command,
    csrfToken,
    parseProposalApprovalResult,
    signal,
  );
}
export async function rejectProposal(
  proposalId: string,
  command: { projectId: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    `/api/v1/orchestrator/proposals/${proposalId}/reject`,
    command,
    csrfToken,
    parseConversationProposal,
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
  return parseConversationProposal(await response.json());
}
export async function translateProposal(
  proposalId: string,
  command: { projectId: string },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    `/api/v1/orchestrator/proposals/${proposalId}/translate`,
    command,
    csrfToken,
    parseTranslationTaskResult,
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
  sourceTaskId?: string;
  modelAttribution?: {
    provider: string;
    requestedModelId: string;
    resolvedModelId?: string;
    costUsdMicros: number;
  };
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
  return commandRequest(
    "/api/v1/orchestrator/conversations",
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    parseConversationStartResult,
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
  return commandRequest(
    `/api/v1/orchestrator/conversations/${conversationId}/messages`,
    {
      ...command,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    },
    csrfToken,
    parseSendMessageResult,
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
  return parseConversationMessageList(await response.json());
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
  return parseConversationSummaryList(await response.json());
}
export async function renameConversation(
  conversationId: string,
  command: { projectId: string; title: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  return commandRequest(
    `/api/v1/orchestrator/conversations/${conversationId}/rename`,
    command,
    csrfToken,
    parseConversationSummary,
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
  return commandRequest(
    `/api/v1/orchestrator/conversations/${conversationId}/archive`,
    command,
    csrfToken,
    parseConversationSummary,
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
  return parseReplyTaskStatus(await response.json());
}
export async function cancelReplyTask(
  taskId: string,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<{ taskId: string; state: string }> {
  return commandRequest(
    `/api/v1/orchestrator/reply-tasks/${taskId}/cancel`,
    {},
    csrfToken,
    parseReplyTaskStatus,
    signal,
  );
}
export interface ReplyStreamSubscription {
  close(): void;
}
export function subscribeReplyStream(
  taskId: string,
  callbacks: {
    onChunk(chunk: { ordinal: number; fragment: string }): void;
    onDone(done: { state: string }): void;
    onRetry?(retry: { after: number }): void;
    onError(error: Error): void;
  },
  afterOrdinal = 0,
): ReplyStreamSubscription {
  if (
    !/^[a-f0-9-]{36}$/.test(taskId) ||
    !Number.isInteger(afterOrdinal) ||
    afterOrdinal < 0
  )
    throw new Error("Invalid reply stream cursor.");
  if (typeof EventSource === "undefined")
    throw new Error("Reply streaming is unavailable in this browser.");
  const source = new EventSource(
    `/api/v1/orchestrator/reply-tasks/${taskId}/stream?after=${afterOrdinal}`,
  );
  source.addEventListener("chunk", (event) => {
    try {
      callbacks.onChunk(parseReplyStreamChunk(JSON.parse(event.data)));
    } catch (error) {
      source.close();
      callbacks.onError(
        error instanceof Error ? error : new Error("Invalid reply stream."),
      );
    }
  });
  source.addEventListener("done", (event) => {
    try {
      callbacks.onDone(parseReplyStreamDone(JSON.parse(event.data)));
    } catch (error) {
      callbacks.onError(
        error instanceof Error ? error : new Error("Invalid reply stream."),
      );
    } finally {
      source.close();
    }
  });
  source.addEventListener("retry", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (
        typeof payload !== "object" ||
        payload === null ||
        !Number.isInteger((payload as { after?: unknown }).after) ||
        (payload as { after: number }).after < 0
      )
        throw new Error("Invalid reply stream retry payload");
      callbacks.onRetry?.({ after: (payload as { after: number }).after });
    } catch (error) {
      callbacks.onError(
        error instanceof Error ? error : new Error("Invalid reply stream."),
      );
    } finally {
      source.close();
    }
  });
  source.onerror = () => {
    source.close();
    callbacks.onError(new Error("Reply stream disconnected."));
  };
  return { close: () => source.close() };
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
  return parseConversationAttachment(await response.json());
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
  return parseConversationAttachmentList(await response.json());
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
  return commandRequest(
    "/api/v1/policy/draft",
    command,
    csrfToken,
    parsePolicyStateResult,
    signal,
  );
}
export async function validatePolicyDraft(
  command: { id: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    "/api/v1/policy/validate",
    command,
    csrfToken,
    parsePolicyStateResult,
    signal,
  );
}
export async function approvePolicyDraft(
  command: { id: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    "/api/v1/policy/approve",
    command,
    csrfToken,
    parsePolicyStateResult,
    signal,
  );
}
export async function activatePolicyDraft(
  command: { id: string; expectedVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    "/api/v1/policy/activate",
    command,
    csrfToken,
    parsePolicyStateResult,
    signal,
  );
}
export async function rollbackPolicy(
  command: { policyKey: string; targetVersion: number },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    "/api/v1/policy/rollback",
    command,
    csrfToken,
    parsePolicyStateResult,
    signal,
  );
}
export async function createCodexOverride(
  command: { taskId: string; reason: string; expiresAt: string },
  csrfToken: string,
  signal?: AbortSignal,
) {
  return commandRequest(
    "/api/v1/policy/codex-override",
    command,
    csrfToken,
    parseCodexOverrideResult,
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
  return parseActivePolicy(await response.json());
}
// parse is mandatory, not optional: a new call site can't compile without
// wiring a validator, which is exactly the gap this milestone closes --
// every one of these commands used to hand its response to the caller on
// an unchecked `as` cast (CONTRACT-015 M5).
async function commandRequest<T>(
  path: string,
  command: unknown,
  csrfToken: string,
  parse: (value: unknown) => T,
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
  return parse(await response.json());
}
