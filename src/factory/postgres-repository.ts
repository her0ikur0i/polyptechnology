import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  blueprintDigest,
  isolatedProjectReferences,
  parseBlueprint,
} from "./blueprint.js";
import { ProjectLifecycle, type TransitionRequest } from "./lifecycle.js";
import type {
  BlueprintVersion,
  CapacityLease,
  CapacityLimits,
  CapacityObservation,
  CapacityRequest,
  GeneratedProject,
  LifecycleRecord,
} from "./types.js";
import { rankEligible } from "./capacity.js";

export class PostgresProjectFactory {
  constructor(private readonly pool: Pool) {}
  async publishBlueprint(input: {
    blueprintId: string;
    versionId: string;
    version: number;
    document: unknown;
    createdAt: string;
  }): Promise<BlueprintVersion> {
    const document = parseBlueprint(input.document),
      digest = blueprintDigest(document),
      client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await client.query<{
        slug: string;
        display_name: string;
      }>(
        "SELECT slug,display_name FROM project_blueprints WHERE id=$1 FOR UPDATE",
        [input.blueprintId],
      );
      if (identity.rowCount === 0)
        await client.query(
          "INSERT INTO project_blueprints(id,slug,display_name,created_at) VALUES($1,$2,$3,$4)",
          [
            input.blueprintId,
            document.slug,
            document.displayName,
            input.createdAt,
          ],
        );
      else if (
        identity.rows[0]!.slug !== document.slug ||
        identity.rows[0]!.display_name !== document.displayName
      )
        throw new Error("blueprint identity mismatch");
      const replay = await client.query<{
        blueprint_id: string;
        version: number;
        status: BlueprintVersion["status"];
        document_sha256: string;
        created_at: Date;
        published_at: Date;
      }>(
        "SELECT blueprint_id,version,status,document_sha256,created_at,published_at FROM project_blueprint_versions WHERE id=$1",
        [input.versionId],
      );
      if (replay.rowCount === 1) {
        const row = replay.rows[0]!;
        if (
          row.blueprint_id !== input.blueprintId ||
          row.version !== input.version ||
          row.document_sha256 !== digest ||
          row.status !== "published"
        )
          throw new Error("blueprint version idempotency mismatch");
        await client.query("COMMIT");
        return {
          id: input.versionId,
          blueprintId: input.blueprintId,
          version: input.version,
          status: "published",
          document,
          documentSha256: digest,
          createdAt: row.created_at.toISOString(),
          publishedAt: row.published_at.toISOString(),
        };
      }
      await client.query(
        "UPDATE project_blueprint_versions SET status='superseded' WHERE blueprint_id=$1 AND status='published'",
        [input.blueprintId],
      );
      await client.query(
        "INSERT INTO project_blueprint_versions(id,blueprint_id,version,status,document,document_sha256,created_at,published_at) VALUES($1,$2,$3,'published',$4,$5,$6,$6)",
        [
          input.versionId,
          input.blueprintId,
          input.version,
          document,
          digest,
          input.createdAt,
        ],
      );
      await client.query("COMMIT");
      return {
        id: input.versionId,
        blueprintId: input.blueprintId,
        version: input.version,
        status: "published",
        document,
        documentSha256: digest,
        createdAt: input.createdAt,
        publishedAt: input.createdAt,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async createProject(input: {
    id: string;
    slug: string;
    displayName: string;
    blueprintVersionId: string;
    createdAt: string;
  }): Promise<GeneratedProject> {
    const existing = await this.getProject(input.id);
    if (existing) {
      if (
        existing.slug !== input.slug ||
        existing.displayName !== input.displayName ||
        existing.blueprintVersionId !== input.blueprintVersionId
      )
        throw new Error("project idempotency mismatch");
      return existing;
    }
    const refs = isolatedProjectReferences(input.slug, input.id),
      result = await this.pool.query(
        "INSERT INTO generated_projects(id,slug,display_name,blueprint_id,blueprint_version_id,state,version,repository_ref,workspace_ref,database_namespace,secret_namespace,budget_scope,created_at,updated_at) SELECT $1,$2,$3,blueprint_id,id,'idea',0,$5,$6,$7,$8,$9,$4,$4 FROM project_blueprint_versions WHERE id=$10 AND status='published' RETURNING *",
        [
          input.id,
          input.slug,
          input.displayName,
          input.createdAt,
          refs.repositoryRef,
          refs.workspaceRef,
          refs.databaseNamespace,
          refs.secretNamespace,
          refs.budgetScope,
          input.blueprintVersionId,
        ],
      );
    if (result.rowCount !== 1)
      throw new Error("published blueprint version missing");
    return project(result.rows[0] as ProjectRow);
  }
  async transition(projectId: string, request: TransitionRequest) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        "SELECT * FROM project_lifecycle_events WHERE project_id=$1 AND idempotency_key=$2",
        [projectId, request.idempotencyKey],
      );
      if (prior.rowCount === 1) {
        const current = await lockedProject(client, projectId);
        await client.query("COMMIT");
        return {
          project: current,
          record: lifecycle(prior.rows[0] as LifecycleRow),
          replay: true,
        } as const;
      }
      const current = await lockedProject(client, projectId),
        decision = new ProjectLifecycle().transition(current, request);
      await client.query(
        "UPDATE generated_projects SET state=$2,version=$3,updated_at=$4 WHERE id=$1 AND version=$5",
        [
          projectId,
          decision.project.state,
          decision.project.version,
          decision.project.updatedAt,
          request.expectedVersion,
        ],
      );
      await client.query(
        "INSERT INTO project_lifecycle_events(id,project_id,idempotency_key,from_state,to_state,actor_id,correlation_id,evidence_sha256,approval_ref,resulting_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          decision.record.id,
          projectId,
          decision.record.idempotencyKey,
          decision.record.from,
          decision.record.to,
          decision.record.actorId,
          decision.record.correlationId,
          decision.record.evidenceSha256,
          decision.record.approvalRef ?? null,
          decision.record.resultingVersion,
          decision.record.occurredAt,
        ],
      );
      await client.query("COMMIT");
      return decision;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async getProject(id: string) {
    const result = await this.pool.query(
      "SELECT * FROM generated_projects WHERE id=$1",
      [id],
    );
    return result.rowCount ? project(result.rows[0] as ProjectRow) : undefined;
  }
  async reserveCapacity(
    request: CapacityRequest,
    limits: CapacityLimits,
    freeDiskMiB: number,
    nowMs: number,
    ttlMs: number,
  ): Promise<CapacityLease> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new Error("invalid reservation ttl");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('factory-capacity'))",
      );
      await client.query(
        "DELETE FROM capacity_reservations WHERE expires_at<=to_timestamp($1/1000.0)",
        [nowMs],
      );
      const replay = await client.query<CapacityRow>(
        "SELECT * FROM capacity_reservations WHERE request_id=$1",
        [request.id],
      );
      if (replay.rowCount === 1) {
        const row = replay.rows[0]!,
          prior = capacityRequest(row);
        if (JSON.stringify(prior) !== JSON.stringify(request))
          throw new Error("capacity idempotency mismatch");
        await client.query("COMMIT");
        return {
          request: prior,
          fence: Number(row.fence),
          expiresAtMs: row.expires_at.getTime(),
        };
      }
      const rows = await client.query<CapacityRow>(
        "SELECT * FROM capacity_reservations ORDER BY request_id",
      );
      const observation: CapacityObservation = {
        freeDiskMiB,
        active: rows.rows.map(capacityRequest),
      };
      if (rankEligible([request], observation, limits, nowMs).length !== 1)
        throw new Error("capacity unavailable");
      const fenceResult = await client.query<{ fence: string }>(
          "SELECT nextval('capacity_fencing_seq') AS fence",
        ),
        fence = Number(fenceResult.rows[0]!.fence),
        expiresAtMs = nowMs + ttlMs;
      await client.query(
        "INSERT INTO capacity_reservations(request_id,project_id,provider_id,fence,cpu_millis,memory_mib,disk_mib,max_processes,network,interactive,priority,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0),to_timestamp($13/1000.0))",
        [
          request.id,
          request.projectId,
          request.providerId,
          fence,
          request.resources.cpuMillis,
          request.resources.memoryMiB,
          request.resources.diskMiB,
          request.resources.maxProcesses,
          request.resources.network,
          request.interactive,
          request.priority,
          expiresAtMs,
          nowMs,
        ],
      );
      await client.query("COMMIT");
      return { request, fence, expiresAtMs };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async releaseCapacity(requestId: string, fence: number) {
    const result = await this.pool.query(
      "DELETE FROM capacity_reservations WHERE request_id=$1 AND fence=$2",
      [requestId, fence],
    );
    if (result.rowCount !== 1) throw new Error("stale capacity fence");
  }
}
type ProjectRow = {
  id: string;
  slug: string;
  display_name: string;
  blueprint_version_id: string;
  state: GeneratedProject["state"];
  version: string;
  repository_ref: string;
  workspace_ref: string;
  database_namespace: string;
  secret_namespace: string;
  budget_scope: string;
  created_at: Date;
  updated_at: Date;
};
type LifecycleRow = {
  id: string;
  project_id: string;
  idempotency_key: string;
  from_state: LifecycleRecord["from"];
  to_state: LifecycleRecord["to"];
  actor_id: string;
  correlation_id: string;
  evidence_sha256: string;
  approval_ref: string | null;
  resulting_version: string;
  occurred_at: Date;
};
type CapacityRow = {
  request_id: string;
  project_id: string;
  provider_id: string;
  cpu_millis: number;
  memory_mib: number;
  disk_mib: number;
  max_processes: number;
  network: CapacityRequest["resources"]["network"];
  interactive: boolean;
  priority: number;
  created_at: Date;
  fence: string;
  expires_at: Date;
};
const project = (row: ProjectRow): GeneratedProject => ({
  id: row.id,
  slug: row.slug,
  displayName: row.display_name,
  blueprintVersionId: row.blueprint_version_id,
  state: row.state,
  version: Number(row.version),
  repositoryRef: row.repository_ref,
  workspaceRef: row.workspace_ref,
  databaseNamespace: row.database_namespace,
  secretNamespace: row.secret_namespace,
  budgetScope: row.budget_scope,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const lifecycle = (row: LifecycleRow): LifecycleRecord => ({
  id: row.id,
  projectId: row.project_id,
  idempotencyKey: row.idempotency_key,
  from: row.from_state,
  to: row.to_state,
  actorId: row.actor_id,
  correlationId: row.correlation_id,
  evidenceSha256: row.evidence_sha256,
  ...(row.approval_ref ? { approvalRef: row.approval_ref } : {}),
  resultingVersion: Number(row.resulting_version),
  occurredAt: row.occurred_at.toISOString(),
});
const capacityRequest = (row: CapacityRow): CapacityRequest => ({
  id: row.request_id,
  projectId: row.project_id,
  providerId: row.provider_id,
  priority: row.priority,
  interactive: row.interactive,
  queuedAtMs: row.created_at.getTime(),
  budgetAvailable: true,
  resources: {
    cpuMillis: row.cpu_millis,
    memoryMiB: row.memory_mib,
    diskMiB: row.disk_mib,
    maxProcesses: row.max_processes,
    network: row.network,
  },
});
async function lockedProject(client: PoolClient, id: string) {
  const result = await client.query(
    "SELECT * FROM generated_projects WHERE id=$1 FOR UPDATE",
    [id],
  );
  if (result.rowCount !== 1) throw new Error("project missing");
  return project(result.rows[0] as ProjectRow);
}
export const newProjectId = () => randomUUID();
