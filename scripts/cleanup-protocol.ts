// The "cleanup protocol" — reset the factory's work products to a clean state.
//
// The owner invokes this by saying "cleanup protocol". It deletes every
// generated project, conversation, task, attempt, contract, milestone, budget
// scope, blueprint and their on-disk workspaces, temp files, and old release
// images. It keeps the factory's own config (providers, policies, Telegram
// settings, audit records) untouched.
//
// Run:
//   DATABASE_URL=… PROJECT_WORKSPACES_ROOT=… \
//     node --import tsx scripts/cleanup-protocol.ts
//
// Safety: it is deliberately destructive. There is no dry-run; invoking it IS
// the confirmation. Audit/domain-event tables are left alone because they are
// the factory's history, not its work products.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

// The append-only tables that reject mutation by trigger. Deleting work
// products from them requires lifting the trigger for the duration of the
// transaction; the trigger is re-enabled before commit so the next write is
// guarded again.
const IMMUTABLE_TRIGGERS: ReadonlyArray<{ table: string; trigger: string }> = [
  { table: "attachment_events", trigger: "attachment_events_immutable" },
  {
    table: "conversation_messages",
    trigger: "conversation_messages_immutable",
  },
  { table: "context_manifests", trigger: "context_manifests_immutable" },
  {
    table: "project_lifecycle_events",
    trigger: "project_lifecycle_events_immutable",
  },
  { table: "operation_task_specs", trigger: "operation_task_specs_immutable" },
  {
    table: "operation_task_evidence",
    trigger: "operation_task_evidence_immutable",
  },
  { table: "task_costs", trigger: "task_costs_immutable" },
  { table: "task_role_overrides", trigger: "task_role_overrides_immutable" },
  { table: "ai_usage_events", trigger: "ai_usage_immutable" },
  { table: "ai_attempt_verifications", trigger: "ai_verification_immutable" },
  {
    table: "ai_attempt_reconciliations",
    trigger: "ai_reconciliation_immutable",
  },
  { table: "provider_artifacts", trigger: "provider_artifacts_immutable" },
  {
    table: "project_blueprint_versions",
    trigger: "published_blueprint_immutable",
  },
];

// Foreign-key-safe order: children before their parents. `generated_projects`
// sits before `project_blueprint_*` because it references them, `tasks` before
// `milestones`/`factory_contracts`, `provider_artifacts` before `tasks` and
// `ai_gateway_attempts`, and so on.
const DELETE_ORDER: ReadonlyArray<string> = [
  "DELETE FROM attachment_events",
  "DELETE FROM conversation_attachments",
  "DELETE FROM conversation_messages",
  "DELETE FROM conversation_reply_chunks",
  "DELETE FROM conversation_provider_sessions",
  "DELETE FROM conversation_idempotency",
  "DELETE FROM approval_requests",
  "DELETE FROM conversation_proposals",
  "DELETE FROM context_manifests",
  "DELETE FROM conversations",
  "DELETE FROM operation_task_evidence",
  "DELETE FROM task_costs",
  "DELETE FROM task_role_overrides",
  "DELETE FROM task_attempts",
  "DELETE FROM task_leases",
  "DELETE FROM provider_artifacts",
  "DELETE FROM ai_attempt_reconciliations",
  "DELETE FROM ai_attempt_verifications",
  "DELETE FROM ai_usage_events",
  "DELETE FROM ai_gateway_attempts",
  "DELETE FROM operation_task_specs",
  "DELETE FROM tasks",
  "DELETE FROM milestones",
  "DELETE FROM gate_evidence",
  "DELETE FROM ai_budget_accounts",
  "DELETE FROM factory_contracts",
  "DELETE FROM project_lifecycle_events",
  "DELETE FROM capacity_reservations",
  "DELETE FROM generated_projects",
  "DELETE FROM project_blueprint_versions",
  "DELETE FROM project_blueprints",
];

const RELEASES_ROOT =
  process.env.RELEASES_ROOT ?? "/opt/polyp-ai-factory/releases";
const KEEP_RELEASES = 4;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    console.error("cleanup-protocol: DATABASE_URL is required");
    process.exit(1);
  }
  const workspacesRoot = process.env.PROJECT_WORKSPACES_ROOT;

  const pool = new pg.Pool({ connectionString: databaseUrl });

  // 1. Database reset.
  const deleted = new Map<string, number>();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { table, trigger } of IMMUTABLE_TRIGGERS)
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const statement of DELETE_ORDER) {
      const result = await client.query(statement);
      const table = /^DELETE FROM (\w+)/.exec(statement)?.[1] ?? "?";
      deleted.set(table, result.rowCount ?? 0);
    }
    for (const { table, trigger } of IMMUTABLE_TRIGGERS)
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // 2. Workspaces.
  let workspacesRemoved = 0;
  if (workspacesRoot !== undefined) {
    try {
      const entries = await readdir(workspacesRoot);
      for (const entry of entries)
        await rm(join(workspacesRoot, entry), { recursive: true, force: true });
      workspacesRemoved = entries.length;
    } catch {
      workspacesRemoved = 0;
    }
  }

  // 3. Old releases.
  let releasesRemoved = 0;
  try {
    const entries = (await readdir(RELEASES_ROOT)).sort();
    const excess = Math.max(0, entries.length - KEEP_RELEASES);
    for (const entry of entries.slice(0, excess)) {
      await rm(join(RELEASES_ROOT, entry), { recursive: true, force: true });
      releasesRemoved += 1;
    }
  } catch {
    releasesRemoved = 0;
  }

  await pool.end();

  const total = [...deleted.values()].reduce((a, b) => a + b, 0);
  console.log(
    [
      "cleanup protocol complete",
      `  database rows deleted: ${total}`,
      `  workspaces removed:    ${workspacesRemoved}`,
      `  releases pruned:       ${releasesRemoved}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(
    "cleanup protocol failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
