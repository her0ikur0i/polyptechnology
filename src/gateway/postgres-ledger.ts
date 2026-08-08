import type { Pool, PoolClient } from "pg";
import type {
  AttemptLedger,
  GatewayAttempt,
  ManagedCompletion,
  NormalizedUsage,
  AttemptVerification,
} from "./types.js";
type Row = {
  id: string;
  idempotency_key: string;
  request_hash: string;
  outcome: GatewayAttempt["outcome"];
  provider_id: GatewayAttempt["route"]["provider"];
  requested_model_id: string;
  role: string;
  mode?: GatewayAttempt["route"]["mode"] | null;
  effort?: GatewayAttempt["route"]["effort"] | null;
  attribution: GatewayAttempt["attribution"];
  policy_version: string;
  reserved_cost_usd_micros: string;
  provider_request_id?: string | null;
  resolved_model_id?: string | null;
  resolution_source?: GatewayAttempt["resolutionSource"] | null;
  output_sha256?: string | null;
  failure_code?: string | null;
  created_at: Date;
  finalized_at?: Date | null;
  input_tokens?: string | null;
  output_tokens?: string | null;
  reasoning_tokens?: string | null;
  cache_read_tokens?: string | null;
  cache_write_tokens?: string | null;
  cost_usd_micros?: string | null;
};
const mapped = (row: Row): GatewayAttempt => {
  const base: GatewayAttempt = {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    outcome: row.outcome,
    route: {
      provider: row.provider_id,
      requestedModelId: row.requested_model_id,
      role: row.role,
      ...(row.mode ? { mode: row.mode } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
    },
    attribution: row.attribution,
    policyVersion: row.policy_version,
    reservedCostUsdMicros: Number(row.reserved_cost_usd_micros),
    createdAt: row.created_at,
  };
  if (row.provider_request_id) base.providerRequestId = row.provider_request_id;
  if (row.resolved_model_id) base.resolvedModelId = row.resolved_model_id;
  if (row.resolution_source) base.resolutionSource = row.resolution_source;
  if (row.output_sha256) base.outputSha256 = row.output_sha256;
  if (row.failure_code) base.failureCode = row.failure_code;
  if (row.finalized_at) base.finalizedAt = row.finalized_at;
  if (row.input_tokens !== null && row.input_tokens !== undefined)
    base.usage = {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      costUsdMicros: Number(row.cost_usd_micros),
    };
  return base;
};
const select =
  "SELECT a.*,u.input_tokens,u.output_tokens,u.reasoning_tokens,u.cache_read_tokens,u.cache_write_tokens,u.cost_usd_micros FROM ai_gateway_attempts a LEFT JOIN LATERAL (SELECT SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,SUM(reasoning_tokens) reasoning_tokens,SUM(cache_read_tokens) cache_read_tokens,SUM(cache_write_tokens) cache_write_tokens,SUM(cost_usd_micros) cost_usd_micros FROM ai_usage_events WHERE attempt_id=a.id) u ON true";
export class PostgresAttemptLedger implements AttemptLedger {
  constructor(private readonly pool: Pool) {}
  async reserve(attempt: GatewayAttempt) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [attempt.idempotencyKey],
      );
      const existing = await client.query<Row>(
        `${select} WHERE a.idempotency_key=$1 FOR UPDATE OF a`,
        [attempt.idempotencyKey],
      );
      if (existing.rowCount) {
        const value = mapped(existing.rows[0]!);
        if (value.requestHash !== attempt.requestHash)
          throw new Error("idempotency intent mismatch");
        await client.query("COMMIT");
        return { attempt: value, created: false };
      }
      const budget = await client.query(
        "UPDATE ai_budget_accounts SET reserved_usd_micros=reserved_usd_micros+$2 WHERE scope_id=$1 AND spent_usd_micros+reserved_usd_micros+$2<=max_cost_usd_micros RETURNING scope_id",
        [attempt.attribution.contractId, attempt.reservedCostUsdMicros],
      );
      if (budget.rowCount !== 1)
        throw new Error("gateway budget unavailable or exhausted");
      await client.query(
        "INSERT INTO ai_gateway_attempts(id,idempotency_key,request_hash,outcome,provider_id,requested_model_id,role,mode,effort,attribution,policy_version,budget_scope_id,reserved_cost_usd_micros,created_at) VALUES($1,$2,$3,'reserved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          attempt.id,
          attempt.idempotencyKey,
          attempt.requestHash,
          attempt.route.provider,
          attempt.route.requestedModelId,
          attempt.route.role,
          attempt.route.mode ?? null,
          attempt.route.effort ?? null,
          attempt.attribution,
          attempt.policyVersion,
          attempt.attribution.contractId,
          attempt.reservedCostUsdMicros,
          attempt.createdAt,
        ],
      );
      await client.query("COMMIT");
      return { attempt: structuredClone(attempt), created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async dispatched(id: string) {
    const result = await this.pool.query(
      "UPDATE ai_gateway_attempts SET outcome='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1 AND outcome='reserved'",
      [id],
    );
    if (result.rowCount !== 1) throw new Error("attempt cannot dispatch");
  }
  async succeed(id: string, result: ManagedCompletion, sha: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Row>(
        "SELECT * FROM ai_gateway_attempts WHERE id=$1 AND outcome='dispatched' FOR UPDATE",
        [id],
      );
      if (current.rowCount !== 1) throw new Error("attempt cannot succeed");
      const row = current.rows[0]!;
      await this.charge(client, row, result.usage);
      for (const usage of result.modelUsage)
        await client.query(
          "INSERT INTO ai_usage_events(attempt_id,provider_request_id,provider_id,requested_model_id,resolved_model_id,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost_usd_micros,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)",
          [
            id,
            result.providerRequestId,
            row.provider_id,
            row.requested_model_id,
            usage.resolvedModelId,
            usage.inputTokens,
            usage.outputTokens,
            usage.reasoningTokens,
            usage.cacheReadTokens,
            usage.cacheWriteTokens,
            usage.costUsdMicros,
          ],
        );
      await client.query(
        "UPDATE ai_gateway_attempts SET outcome='succeeded',provider_request_id=$2,resolved_model_id=$3,resolution_source=$4,output_sha256=$5,finalized_at=CURRENT_TIMESTAMP WHERE id=$1",
        [
          id,
          result.providerRequestId,
          result.resolvedModelId,
          result.resolutionSource,
          sha,
        ],
      );
      await client.query("COMMIT");
      return (await this.byId(id))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async reject(id: string, result: ManagedCompletion, code: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Row>(
        "SELECT * FROM ai_gateway_attempts WHERE id=$1 AND outcome='dispatched' FOR UPDATE",
        [id],
      );
      if (current.rowCount !== 1)
        throw new Error("attempt cannot reject result");
      const row = current.rows[0]!;
      await this.charge(client, row, result.usage);
      for (const usage of result.modelUsage)
        await client.query(
          "INSERT INTO ai_usage_events(attempt_id,provider_request_id,provider_id,requested_model_id,resolved_model_id,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost_usd_micros,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)",
          [
            id,
            result.providerRequestId,
            row.provider_id,
            row.requested_model_id,
            usage.resolvedModelId,
            usage.inputTokens,
            usage.outputTokens,
            usage.reasoningTokens,
            usage.cacheReadTokens,
            usage.cacheWriteTokens,
            usage.costUsdMicros,
          ],
        );
      await client.query(
        "UPDATE ai_gateway_attempts SET outcome='failed',provider_request_id=$2,resolved_model_id=$3,resolution_source=$4,failure_code=$5,finalized_at=CURRENT_TIMESTAMP WHERE id=$1",
        [
          id,
          result.providerRequestId,
          result.resolvedModelId,
          result.resolutionSource,
          code.slice(0, 500),
        ],
      );
      await client.query("COMMIT");
      return (await this.byId(id))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async fail(
    id: string,
    code: string,
    unknown: boolean,
    providerRequestId?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Row>(
        "SELECT * FROM ai_gateway_attempts WHERE id=$1 AND outcome IN ('reserved','dispatched') FOR UPDATE",
        [id],
      );
      if (current.rowCount !== 1) throw new Error("attempt already finalized");
      const row = current.rows[0]!;
      if (!unknown)
        await client.query(
          "UPDATE ai_budget_accounts SET reserved_usd_micros=reserved_usd_micros-$2 WHERE scope_id=$1",
          [row.attribution.contractId, Number(row.reserved_cost_usd_micros)],
        );
      await client.query(
        "UPDATE ai_gateway_attempts SET outcome=$2,failure_code=$3,provider_request_id=$4,finalized_at=CURRENT_TIMESTAMP WHERE id=$1",
        [
          id,
          unknown ? "outcome_unknown" : "failed",
          code.slice(0, 500),
          providerRequestId ?? null,
        ],
      );
      await client.query("COMMIT");
      return (await this.byId(id))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async getByIdempotency(key: string) {
    const result = await this.pool.query<Row>(
      `${select} WHERE a.idempotency_key=$1`,
      [key],
    );
    return result.rowCount ? mapped(result.rows[0]!) : undefined;
  }
  async reconcileUnknownAsFailed(
    id: string,
    reason: string,
    evidenceSha256: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Row>(
        "SELECT * FROM ai_gateway_attempts WHERE id=$1 AND outcome='outcome_unknown' FOR UPDATE",
        [id],
      );
      if (current.rowCount !== 1)
        throw new Error("attempt is not outcome_unknown");
      const row = current.rows[0]!;
      if (!/^[a-f0-9]{64}$/.test(evidenceSha256))
        throw new Error("invalid reconciliation evidence");
      if (
        row.provider_request_id !== null &&
        row.provider_request_id !== undefined
      )
        throw new Error("provider request requires external reconciliation");
      await client.query(
        "UPDATE ai_budget_accounts SET reserved_usd_micros=reserved_usd_micros-$2 WHERE scope_id=$1 AND reserved_usd_micros>=$2",
        [row.attribution.contractId, Number(row.reserved_cost_usd_micros)],
      );
      await client.query(
        "UPDATE ai_gateway_attempts SET outcome='failed',failure_code=$2,finalized_at=CURRENT_TIMESTAMP WHERE id=$1",
        [id, reason.slice(0, 500)],
      );
      await client.query(
        "INSERT INTO ai_attempt_reconciliations(attempt_id,decision,reason,evidence_sha256,reconciled_at) VALUES($1,'failed_no_charge',$2,$3,CURRENT_TIMESTAMP)",
        [id, reason.slice(0, 500), evidenceSha256],
      );
      await client.query("COMMIT");
      return (await this.byId(id))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async recordVerification(
    attemptId: string,
    passed: boolean,
    verifier: string,
    evidenceSha256: string,
  ) {
    if (verifier.length === 0 || !/^[a-f0-9]{64}$/.test(evidenceSha256))
      throw new Error("invalid verification");
    const result = await this.pool.query<{ verified_at: Date }>(
      "INSERT INTO ai_attempt_verifications(attempt_id,passed,verifier,evidence_sha256,verified_at) SELECT id,$2,$3,$4,CURRENT_TIMESTAMP FROM ai_gateway_attempts WHERE id=$1 AND outcome='succeeded' ON CONFLICT(attempt_id) DO NOTHING RETURNING verified_at",
      [attemptId, passed, verifier, evidenceSha256],
    );
    if (result.rowCount !== 1)
      throw new Error("attempt cannot be verified or already verified");
    return {
      attemptId,
      passed,
      verifier,
      evidenceSha256,
      verifiedAt: result.rows[0]!.verified_at,
    } satisfies AttemptVerification;
  }
  async verification(attemptId: string) {
    const result = await this.pool.query<{
      attempt_id: string;
      passed: boolean;
      verifier: string;
      evidence_sha256: string;
      verified_at: Date;
    }>("SELECT * FROM ai_attempt_verifications WHERE attempt_id=$1", [
      attemptId,
    ]);
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : ({
          attemptId: row.attempt_id,
          passed: row.passed,
          verifier: row.verifier,
          evidenceSha256: row.evidence_sha256,
          verifiedAt: row.verified_at,
        } satisfies AttemptVerification);
  }
  private async byId(id: string) {
    const result = await this.pool.query<Row>(`${select} WHERE a.id=$1`, [id]);
    return result.rowCount ? mapped(result.rows[0]!) : undefined;
  }
  private async charge(client: PoolClient, row: Row, usage: NormalizedUsage) {
    if (usage.costUsdMicros > Number(row.reserved_cost_usd_micros))
      throw new Error("actual cost exceeds reservation");
    const result = await client.query(
      "UPDATE ai_budget_accounts SET reserved_usd_micros=reserved_usd_micros-$2,spent_usd_micros=spent_usd_micros+$3 WHERE scope_id=$1 AND reserved_usd_micros>=$2",
      [
        row.attribution.contractId,
        Number(row.reserved_cost_usd_micros),
        usage.costUsdMicros,
      ],
    );
    if (result.rowCount !== 1) throw new Error("budget reservation missing");
  }
}
