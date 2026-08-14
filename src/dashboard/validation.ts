import type {
  DashboardSnapshot,
  Freshness,
  ModelAttempt,
  TelegramSettings,
} from "./types.js";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
// Every optional field checked below (archivedAt, classification, ...) is
// absent-or-string, never null -- the Postgres row mappers already collapse
// SQL NULL into "key omitted" (src/orchestrator/postgres-store.ts) before a
// response ever reaches this file.
const optionalString = (value: unknown): boolean =>
  value === undefined || string(value);
const arrayOf = <T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): value is T[] => Array.isArray(value) && value.every(guard);
const freshness = new Set<Freshness>(["fresh", "stale", "partial"]);
function observed(value: unknown, data: (value: unknown) => boolean) {
  if (
    !record(value) ||
    !data(value.data) ||
    !string(value.observedAt) ||
    !freshness.has(value.freshness as Freshness) ||
    !string(value.source) ||
    !Array.isArray(value.issues) ||
    !value.issues.every(string)
  )
    throw new Error("Invalid observed dashboard payload");
}
function attempt(value: unknown): value is ModelAttempt {
  return (
    record(value) &&
    string(value.id) &&
    new Set(["deepseek", "codex", "claude"]).has(String(value.provider)) &&
    string(value.requestedModelId) &&
    (value.resolvedModelId === undefined || string(value.resolvedModelId)) &&
    string(value.role) &&
    ["reserved", "running", "succeeded", "failed", "outcome_unknown"].includes(
      String(value.outcome),
    ) &&
    [
      value.inputTokens,
      value.outputTokens,
      value.reasoningTokens,
      value.cacheReadTokens,
      value.cacheWriteTokens,
      value.costUsdMicros,
    ].every(finite) &&
    typeof value.verified === "boolean"
  );
}
function telegram(value: unknown): value is TelegramSettings {
  return (
    record(value) &&
    (value.secretRef === undefined ||
      (string(value.secretRef) && /^secret:\/\//.test(value.secretRef))) &&
    Array.isArray(value.authorizedChatIds) &&
    value.authorizedChatIds.every(string) &&
    Array.isArray(value.authorizedUserIds) &&
    value.authorizedUserIds.every(string) &&
    typeof value.configurationReady === "boolean" &&
    ["not_run", "passed", "failed"].includes(String(value.liveProbeState)) &&
    typeof value.approvalRequiredForProbe === "boolean" &&
    typeof value.webhookRegistered === "boolean"
  );
}
export function parseDashboardSnapshot(value: unknown): DashboardSnapshot {
  if (!record(value)) throw new Error("Invalid dashboard payload");
  for (const key of [
    "attention",
    "projects",
    "contracts",
    "approvals",
  ] as const)
    observed(value[key], (data) => Array.isArray(data));
  observed(
    value.attempts,
    (data) => Array.isArray(data) && data.every(attempt),
  );
  observed(value.telegram, telegram);
  observed(
    value.sequence,
    (data) =>
      record(data) &&
      [
        "running",
        "owner_blocked",
        "gate_failed",
        "completed",
        "stopped",
      ].includes(String(data.state)) &&
      finite(data.ownerBlockers),
  );
  if (
    !record(value.commandPolicy) ||
    !string(value.commandPolicy.csrfToken) ||
    typeof value.commandPolicy.canConfigureTelegram !== "boolean"
  )
    throw new Error("Invalid dashboard command policy");
  return value as unknown as DashboardSnapshot;
}

// -- Every other src/dashboard/api.ts response (CONTRACT-015 M5) --
//
// Same shape as above: a private value-is-T predicate does the checking, a
// thin exported parseX() throws or returns the narrowed value -- no `as`
// cast needed here, unlike parseDashboardSnapshot, because a type predicate
// lets the compiler narrow `value` for us once the checks pass. An enum is
// only enforced where the corresponding api.ts/types.ts type is itself a
// union (e.g. ConversationMessage's "role"); a field typed as plain
// `string` there (ConversationProposal's "state", PolicyStateResult's
// "state", ...) is left open here too, so this file never enforces a
// stricter contract than the one the type already promises.

export function parseTelegramSettings(value: unknown): TelegramSettings {
  if (!telegram(value)) throw new Error("Invalid Telegram settings payload");
  return value;
}

export function parseTelegramTestResult(value: unknown) {
  if (
    !record(value) ||
    !["passed", "failed"].includes(String(value.state)) ||
    !string(value.checkedAt) ||
    !string(value.summary)
  )
    throw new Error("Invalid Telegram test result");
  return value as {
    state: "passed" | "failed";
    checkedAt: string;
    summary: string;
  };
}

function factoryProjectResult(value: unknown): value is {
  projectId: string;
  state: string;
  repositoryRef: string;
} {
  return (
    record(value) &&
    string(value.projectId) &&
    string(value.state) &&
    string(value.repositoryRef)
  );
}
export function parseFactoryProjectResult(value: unknown) {
  if (!factoryProjectResult(value))
    throw new Error("Invalid factory project response");
  return value;
}

function generationTaskResult(value: unknown): value is {
  taskId: string;
  contractId: string;
  milestoneId: string;
} {
  return (
    record(value) &&
    string(value.taskId) &&
    string(value.contractId) &&
    string(value.milestoneId)
  );
}
export function parseGenerationTaskResult(value: unknown) {
  if (!generationTaskResult(value))
    throw new Error("Invalid generation task response");
  return value;
}

function proposalCreationResult(value: unknown): value is {
  conversationId: string;
  proposalId: string;
  state: string;
} {
  return (
    record(value) &&
    string(value.conversationId) &&
    string(value.proposalId) &&
    string(value.state)
  );
}
export function parseProposalCreationResult(value: unknown) {
  if (!proposalCreationResult(value))
    throw new Error("Invalid proposal creation response");
  return value;
}

function proposalDraftResult(value: unknown): value is {
  proposalId: string;
  conversationId: string;
  state: string;
  version: number;
  contractCandidate: string;
} {
  return (
    record(value) &&
    string(value.proposalId) &&
    string(value.conversationId) &&
    string(value.state) &&
    finite(value.version) &&
    string(value.contractCandidate)
  );
}
export function parseProposalDraftResult(value: unknown) {
  if (!proposalDraftResult(value))
    throw new Error("Invalid proposal draft response");
  return value;
}

function proposalApprovalResult(value: unknown): value is {
  proposalId: string;
  projectId: string;
  conversationId: string;
  approvalId: string;
  contractCandidate: string;
  candidateSha256: string;
} {
  return (
    record(value) &&
    string(value.proposalId) &&
    string(value.projectId) &&
    string(value.conversationId) &&
    string(value.approvalId) &&
    string(value.contractCandidate) &&
    string(value.candidateSha256)
  );
}
export function parseProposalApprovalResult(value: unknown) {
  if (!proposalApprovalResult(value))
    throw new Error("Invalid proposal approval response");
  return value;
}

function conversationProposal(value: unknown): value is {
  id: string;
  conversationId: string;
  projectId: string;
  version: number;
  state: string;
  contractCandidate: string;
  candidateSha256: string;
  approvalId?: string;
} {
  return (
    record(value) &&
    string(value.id) &&
    string(value.conversationId) &&
    string(value.projectId) &&
    finite(value.version) &&
    string(value.state) &&
    string(value.contractCandidate) &&
    string(value.candidateSha256) &&
    optionalString(value.approvalId)
  );
}
export function parseConversationProposal(value: unknown) {
  if (!conversationProposal(value))
    throw new Error("Invalid conversation proposal response");
  return value;
}

function translationTaskResult(value: unknown): value is { taskId: string } {
  return record(value) && string(value.taskId);
}
export function parseTranslationTaskResult(value: unknown) {
  if (!translationTaskResult(value))
    throw new Error("Invalid translation task response");
  return value;
}

function conversationStartResult(value: unknown): value is {
  conversationId: string;
  projectId: string;
  title: string;
  version: number;
} {
  return (
    record(value) &&
    string(value.conversationId) &&
    string(value.projectId) &&
    string(value.title) &&
    finite(value.version)
  );
}
export function parseConversationStartResult(value: unknown) {
  if (!conversationStartResult(value))
    throw new Error("Invalid conversation start response");
  return value;
}

type ConversationMessagePayload = {
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
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
  };
};
const messageRoles = new Set(["owner", "assistant", "system"]);
function messageAttribution(
  value: unknown,
): value is NonNullable<ConversationMessagePayload["modelAttribution"]> {
  return (
    record(value) &&
    string(value.provider) &&
    string(value.requestedModelId) &&
    (value.resolvedModelId === undefined || string(value.resolvedModelId)) &&
    finite(value.costUsdMicros) &&
    finite(value.inputTokens) &&
    finite(value.outputTokens) &&
    finite(value.elapsedMs)
  );
}
function conversationMessage(
  value: unknown,
): value is ConversationMessagePayload {
  return (
    record(value) &&
    string(value.id) &&
    string(value.conversationId) &&
    string(value.projectId) &&
    finite(value.ordinal) &&
    messageRoles.has(String(value.role)) &&
    string(value.content) &&
    string(value.classification) &&
    string(value.contentSha256) &&
    string(value.createdAt) &&
    (value.sourceTaskId === undefined || string(value.sourceTaskId)) &&
    (value.modelAttribution === undefined ||
      messageAttribution(value.modelAttribution))
  );
}
export function parseConversationMessageList(
  value: unknown,
): ConversationMessagePayload[] {
  if (!arrayOf(value, conversationMessage))
    throw new Error("Invalid conversation message list response");
  return value;
}

function sendMessageResult(value: unknown): value is {
  message: ConversationMessagePayload;
  replyTaskId: string;
} {
  return (
    record(value) &&
    conversationMessage(value.message) &&
    string(value.replyTaskId)
  );
}
export function parseSendMessageResult(value: unknown) {
  if (!sendMessageResult(value))
    throw new Error("Invalid send message response");
  return value;
}

function conversationSummary(value: unknown): value is {
  id: string;
  projectId: string;
  title: string;
  version: number;
  createdAt: string;
  archivedAt?: string;
} {
  return (
    record(value) &&
    string(value.id) &&
    string(value.projectId) &&
    string(value.title) &&
    finite(value.version) &&
    string(value.createdAt) &&
    optionalString(value.archivedAt)
  );
}
export function parseConversationSummary(value: unknown) {
  if (!conversationSummary(value))
    throw new Error("Invalid conversation summary response");
  return value;
}
export function parseConversationSummaryList(value: unknown) {
  if (!arrayOf(value, conversationSummary))
    throw new Error("Invalid conversation summary list response");
  return value;
}

function replyTaskStatus(
  value: unknown,
): value is { taskId: string; state: string } {
  return record(value) && string(value.taskId) && string(value.state);
}
export function parseReplyTaskStatus(value: unknown) {
  if (!replyTaskStatus(value))
    throw new Error("Invalid reply task status response");
  return value;
}

function replyStreamChunk(value: unknown): value is {
  ordinal: number;
  fragment: string;
} {
  return record(value) && finite(value.ordinal) && string(value.fragment);
}
export function parseReplyStreamChunk(value: unknown) {
  if (!replyStreamChunk(value))
    throw new Error("Invalid reply stream chunk payload");
  return value;
}

function replyStreamDone(value: unknown): value is { state: string } {
  return record(value) && string(value.state);
}
export function parseReplyStreamDone(value: unknown) {
  if (!replyStreamDone(value))
    throw new Error("Invalid reply stream completion payload");
  return value;
}

function conversationAttachment(value: unknown): value is {
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
} {
  return (
    record(value) &&
    string(value.id) &&
    string(value.conversationId) &&
    string(value.projectId) &&
    string(value.objectKey) &&
    string(value.displayName) &&
    string(value.mediaType) &&
    finite(value.sizeBytes) &&
    string(value.sha256) &&
    string(value.state) &&
    optionalString(value.classification)
  );
}
export function parseConversationAttachment(value: unknown) {
  if (!conversationAttachment(value))
    throw new Error("Invalid conversation attachment response");
  return value;
}
export function parseConversationAttachmentList(value: unknown) {
  if (!arrayOf(value, conversationAttachment))
    throw new Error("Invalid conversation attachment list response");
  return value;
}

function policyStateResult(value: unknown): value is {
  id: string;
  version: number;
  state: string;
} {
  return (
    record(value) &&
    string(value.id) &&
    finite(value.version) &&
    string(value.state)
  );
}
// Shared by createPolicyDraft/validatePolicyDraft/approvePolicyDraft/
// activatePolicyDraft/rollbackPolicy -- every step of the lifecycle in
// src/policy/owner-policy-service.ts returns this identical projection.
export function parsePolicyStateResult(value: unknown) {
  if (!policyStateResult(value))
    throw new Error("Invalid policy state response");
  return value;
}

function codexOverrideResult(value: unknown): value is {
  id: string;
  taskId: string;
  expiresAt: string;
} {
  return (
    record(value) &&
    string(value.id) &&
    string(value.taskId) &&
    string(value.expiresAt)
  );
}
export function parseCodexOverrideResult(value: unknown) {
  if (!codexOverrideResult(value))
    throw new Error("Invalid codex override response");
  return value;
}

function activePolicy(value: unknown): value is {
  id: string;
  version: number;
  state: string;
  policy: unknown;
} {
  return (
    record(value) &&
    string(value.id) &&
    finite(value.version) &&
    string(value.state)
  );
}
export function parseActivePolicy(value: unknown) {
  if (!activePolicy(value)) throw new Error("Invalid active policy response");
  return value;
}
