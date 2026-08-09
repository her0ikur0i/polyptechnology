import type { Pool } from "pg";
import { PostgresApprovalRepository } from "../approvals/postgres-repository.js";
import { PostgresTelegramSettingsStore } from "./telegram-settings-store.js";
import type {
  AttentionItem,
  ApprovalSummary,
  ContractSummary,
  DashboardSnapshot,
  ModelAttempt,
  Observed,
  ProjectSummary,
  RunOutcome,
  SequenceSummary,
  TelegramSettings,
} from "../dashboard/types.js";

function observed<T>(
  data: T,
  source: string,
  freshness: Observed<T>["freshness"] = "fresh",
  issues: ReadonlyArray<string> = [],
): Observed<T> {
  return {
    data,
    observedAt: new Date().toISOString(),
    freshness,
    source,
    issues,
  };
}

async function loadProjects(pool: Pool): Promise<ProjectSummary[]> {
  const result = await pool.query<{
    id: string;
    display_name: string;
    state: string;
    updated_at: Date;
  }>(
    "SELECT id, display_name, state, updated_at FROM generated_projects ORDER BY updated_at DESC LIMIT 100",
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.display_name,
    lifecycle: row.state,
    // No richer "needs attention" signal exists per-project yet (e.g. a
    // stalled lifecycle transition) -- "none" is honest, not a placeholder
    // pretending to be a real computed value.
    attention: "none",
    updatedAt: row.updated_at.toISOString(),
  }));
}

// factory_contracts has no title column (migrations/0003_work_engine.sql) --
// the id is the only stable label available; do not invent one.
async function loadContracts(pool: Pool): Promise<ContractSummary[]> {
  const result = await pool.query<{
    id: string;
    status: string;
    published_sha: string | null;
    latest_milestone: string | null;
    gates_total: string;
    gates_passed: string;
  }>(
    `SELECT c.id, c.status, c.published_sha,
            (SELECT m.ordinal::text FROM milestones m WHERE m.contract_id = c.id ORDER BY m.ordinal DESC LIMIT 1) AS latest_milestone,
            COUNT(g.evidence_id) AS gates_total,
            COUNT(g.evidence_id) FILTER (WHERE g.passed) AS gates_passed
     FROM factory_contracts c
     LEFT JOIN gate_evidence g ON g.contract_id = c.id
     GROUP BY c.id, c.status, c.published_sha
     ORDER BY c.id DESC LIMIT 100`,
  );
  return result.rows.map((row) => {
    const total = Number(row.gates_total),
      passed = Number(row.gates_passed);
    const gateStatus =
      total === 0 ? "pending" : passed === total ? "passed" : "failed";
    return {
      id: row.id,
      title: row.id,
      milestone: row.latest_milestone ?? "none",
      state: row.status,
      gateStatus,
      ...(row.published_sha ? { publishedSha: row.published_sha } : {}),
    };
  });
}

async function loadAttempts(pool: Pool): Promise<ModelAttempt[]> {
  const result = await pool.query<{
    id: string;
    provider_id: "deepseek" | "codex" | "claude";
    requested_model_id: string;
    resolved_model_id: string | null;
    resolution_source: "provider_response" | "pinned_request" | null;
    role: string;
    outcome: RunOutcome;
    output_sha256: string | null;
    failure_code: string | null;
    task_id: string | null;
    attempt_ordinal: number | null;
    input_tokens: string | null;
    output_tokens: string | null;
    reasoning_tokens: string | null;
    cache_read_tokens: string | null;
    cache_write_tokens: string | null;
    cost_usd_micros: string | null;
    verified: boolean | null;
  }>(
    `SELECT a.id, a.provider_id, a.requested_model_id, a.resolved_model_id, a.resolution_source,
            a.role, a.outcome, a.output_sha256, a.failure_code,
            a.attribution->>'taskId' AS task_id,
            NULLIF(a.attribution->>'taskAttemptOrdinal','')::int AS attempt_ordinal,
            u.input_tokens, u.output_tokens, u.reasoning_tokens, u.cache_read_tokens,
            u.cache_write_tokens, u.cost_usd_micros, v.passed AS verified
     FROM ai_gateway_attempts a
     LEFT JOIN LATERAL (
       SELECT SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
              SUM(reasoning_tokens) reasoning_tokens, SUM(cache_read_tokens) cache_read_tokens,
              SUM(cache_write_tokens) cache_write_tokens, SUM(cost_usd_micros) cost_usd_micros
       FROM ai_usage_events WHERE attempt_id = a.id
     ) u ON true
     LEFT JOIN ai_attempt_verifications v ON v.attempt_id = a.id
     ORDER BY a.created_at DESC LIMIT 200`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    provider: row.provider_id,
    requestedModelId: row.requested_model_id,
    ...(row.resolved_model_id
      ? { resolvedModelId: row.resolved_model_id }
      : {}),
    ...(row.resolution_source
      ? { resolutionSource: row.resolution_source }
      : {}),
    role: row.role,
    outcome: row.outcome,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    reasoningTokens: Number(row.reasoning_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    costUsdMicros: Number(row.cost_usd_micros ?? 0),
    verified: row.verified === true,
    ...(row.output_sha256 ? { artifactSha256: row.output_sha256 } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.attempt_ordinal !== null
      ? { attemptOrdinal: row.attempt_ordinal }
      : {}),
  }));
}

async function loadApprovals(pool: Pool): Promise<ApprovalSummary[]> {
  const approvals = await new PostgresApprovalRepository(pool).list(100);
  return approvals.map((approval) => ({
    id: approval.id,
    action: approval.target.summary,
    risk: approval.target.risk,
    state: approval.status,
    expiresAt: approval.expiresAt.toISOString(),
    // decidedBy/decidedAt (approval_requests.decided_by/decided_at) are the
    // durable record of who actually decided and when -- for a decision
    // routed through the Telegram webhook (src/control-api/telegram-webhook.ts),
    // decidedBy is the authorized Telegram user id. Surfacing these here is
    // what makes a Telegram decision observable from the dashboard, not
    // just from the settings form (CONTRACT-013 acceptance criterion).
    ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {}),
    ...(approval.decidedAt
      ? { decidedAt: approval.decidedAt.toISOString() }
      : {}),
  }));
}

async function loadTelegram(
  pool: Pool,
  webhookRegistered: boolean,
): Promise<TelegramSettings> {
  const stored = await new PostgresTelegramSettingsStore(pool).get();
  return {
    ...(stored.secretRef ? { secretRef: stored.secretRef } : {}),
    authorizedChatIds: stored.authorizedChatIds,
    authorizedUserIds: stored.authorizedUserIds,
    configurationReady:
      stored.secretRef !== null &&
      stored.authorizedChatIds.length > 0 &&
      stored.authorizedUserIds.length > 0,
    lastCheckedAt: stored.updatedAt.toISOString(),
    // No live-probe mechanism exists yet (docs/operations/telegram-approvals.md:
    // "This contract does not configure a webhook or send a live message").
    liveProbeState: "not_run",
    approvalRequiredForProbe: true,
    webhookRegistered,
  };
}

async function loadSequence(pool: Pool): Promise<SequenceSummary> {
  const result = await pool.query<{
    roadmap_state: SequenceSummary["state"];
    active_contract: string | null;
    active_milestone: string | null;
    heartbeat_at: Date | null;
  }>(
    "SELECT roadmap_state, active_contract, active_milestone, heartbeat_at FROM sequence_supervisor WHERE singleton",
  );
  const row = result.rows[0];
  const blockers = await pool.query<{ n: string }>(
    "SELECT count(*)::int AS n FROM sequence_owner_blockers WHERE resolved_at IS NULL",
  );
  return {
    state: row?.roadmap_state ?? "stopped",
    ...(row?.active_contract ? { contractId: row.active_contract } : {}),
    ...(row?.active_milestone ? { milestoneId: row.active_milestone } : {}),
    ...(row?.heartbeat_at
      ? { heartbeatAt: row.heartbeat_at.toISOString() }
      : {}),
    ownerBlockers: Number(blockers.rows[0]?.n ?? 0),
  };
}

function computeAttention(
  approvals: ReadonlyArray<ApprovalSummary>,
  sequence: SequenceSummary,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (sequence.state === "owner_blocked" || sequence.state === "gate_failed")
    items.push({
      id: `sequence-${sequence.state}`,
      severity: "critical",
      title: `Sequence is ${sequence.state.replace("_", " ")}`,
      detail: `${sequence.ownerBlockers} unresolved owner blocker(s) on ${sequence.contractId ?? "no active contract"}.`,
      sourceHref: "/orchestrator",
    });
  const soon = Date.now() + 60 * 60 * 1000;
  for (const approval of approvals)
    if (
      approval.state === "pending" &&
      new Date(approval.expiresAt).getTime() < soon
    )
      items.push({
        id: `approval-${approval.id}`,
        severity: "warning",
        title: "Approval expiring soon",
        detail: approval.action,
        sourceHref: "/approvals",
      });
  return items;
}

export async function buildDashboardSnapshot(
  pool: Pool,
  csrfToken: string,
  webhookRegistered = false,
): Promise<DashboardSnapshot> {
  const [projects, contracts, attempts, approvals, telegram, sequence] =
    await Promise.all([
      loadProjects(pool),
      loadContracts(pool),
      loadAttempts(pool),
      loadApprovals(pool),
      loadTelegram(pool, webhookRegistered),
      loadSequence(pool),
    ]);
  const sequenceSummary = observed(sequence, "sequence_supervisor");
  const approvalsSummary = observed(approvals, "approval_requests");
  return {
    attention: observed(
      computeAttention(approvals, sequence),
      "computed:approvals+sequence",
    ),
    projects: observed(projects, "generated_projects"),
    contracts: observed(contracts, "factory_contracts"),
    attempts: observed(attempts, "ai_gateway_attempts"),
    approvals: approvalsSummary,
    telegram: observed(telegram, "telegram_settings"),
    sequence: sequenceSummary,
    commandPolicy: { csrfToken, canConfigureTelegram: true },
  };
}
