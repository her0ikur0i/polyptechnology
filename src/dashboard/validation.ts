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
    typeof value.approvalRequiredForProbe === "boolean"
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
