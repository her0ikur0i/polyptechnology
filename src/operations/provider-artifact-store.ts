import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface ProviderArtifactInput {
  attemptId: string;
  taskId: string;
  providerId: string;
  requestedModelId: string;
  resolvedModelId: string;
  status: "accepted" | "rejected";
  outputSha256: string;
  patchSha256: string | null;
  changedLines: number;
  verifierId: string | null;
  reason: string | null;
  fallbackReason: string | null;
}

export interface ProviderArtifactRow {
  taskId: string;
  providerId: string;
  status: "accepted" | "rejected";
  reason: string | null;
}

export class PostgresProviderArtifactStore {
  constructor(private readonly pool: Pool) {}

  async record(input: ProviderArtifactInput): Promise<void> {
    if (
      (input.status === "accepted") !==
      (input.patchSha256 !== null &&
        input.verifierId !== null &&
        input.reason === null)
    )
      throw new Error("provider artifact status/field invariant violated");
    await this.pool.query(
      "INSERT INTO provider_artifacts(id,attempt_id,task_id,provider_id,requested_model_id,resolved_model_id,status,output_sha256,patch_sha256,changed_lines,verifier_id,reason,fallback_reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP)",
      [
        randomUUID(),
        input.attemptId,
        input.taskId,
        input.providerId,
        input.requestedModelId,
        input.resolvedModelId,
        input.status,
        input.outputSha256,
        input.patchSha256,
        input.changedLines,
        input.verifierId,
        input.reason,
        input.fallbackReason,
      ],
    );
  }

  async forTask(taskId: string): Promise<ProviderArtifactRow[]> {
    const result = await this.pool.query<{
      task_id: string;
      provider_id: string;
      status: "accepted" | "rejected";
      reason: string | null;
    }>(
      "SELECT task_id, provider_id, status, reason FROM provider_artifacts WHERE task_id=$1 ORDER BY created_at",
      [taskId],
    );
    return result.rows.map((row) => ({
      taskId: row.task_id,
      providerId: row.provider_id,
      status: row.status,
      reason: row.reason,
    }));
  }
}
