import type { Pool } from "pg";
import type { Gate } from "./types.js";
import type { PublicationRecorder } from "./publication-executor.js";

export class PostgresPublicationRecorder implements PublicationRecorder {
  constructor(private readonly pool: Pool) {}
  async assertGates(
    contractId: string,
    gates: ReadonlyArray<Gate>,
  ): Promise<void> {
    const result = await this.pool.query<{
      gate_id: string;
      evidence_id: string;
      passed: boolean;
    }>(
      "SELECT gate_id,evidence_id::text,passed FROM gate_evidence WHERE contract_id=$1",
      [contractId],
    );
    if (result.rowCount === 0 || result.rows.some((row) => !row.passed))
      throw new Error("durable gate evidence missing or failed");
    const recorded = new Map<string, Set<string>>();
    for (const row of result.rows) {
      const ids = recorded.get(row.gate_id) ?? new Set<string>();
      ids.add(row.evidence_id);
      recorded.set(row.gate_id, ids);
    }
    if (gates.length !== recorded.size)
      throw new Error("durable gate set mismatch");
    for (const gate of gates) {
      const ids = recorded.get(gate.id);
      if (
        !gate.passed ||
        ids === undefined ||
        ids.size !== gate.evidenceIds.length ||
        gate.evidenceIds.some((id) => !ids.has(id))
      )
        throw new Error(`gate evidence mismatch: ${gate.id}`);
    }
  }
  async preparing(contractId: string, baselineSha: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE factory_contracts SET publication_preparing=true WHERE id=$1 AND baseline_sha=$2 AND NOT publication_preparing AND prepared_sha IS NULL AND published_sha IS NULL",
      [contractId, baselineSha],
    );
    if (result.rowCount !== 1)
      throw new Error("publication baseline mismatch or already claimed");
  }
  async prepared(contractId: string, sha: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE factory_contracts SET prepared_sha=$2 WHERE id=$1 AND publication_preparing AND prepared_sha IS NULL AND published_sha IS NULL",
      [contractId, sha],
    );
    if (result.rowCount !== 1) throw new Error("publication was not preparing");
  }
  async published(contractId: string, sha: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE factory_contracts SET published_sha=$2 WHERE id=$1 AND prepared_sha=$2 AND published_sha IS NULL",
      [contractId, sha],
    );
    if (result.rowCount !== 1)
      throw new Error("publication SHA mismatch or already published");
  }
}
