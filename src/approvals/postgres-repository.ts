import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  ApprovalRecord,
  ApprovalRepository,
  DecisionInput,
  DecisionResult,
} from "./types.js";

type Row = {
  id: string;
  target_kind: string;
  target_id: string;
  summary: string;
  risk: string;
  rollback: string;
  status: "pending" | "approved" | "denied";
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  expired?: boolean;
};
const map = (r: Row): ApprovalRecord => ({
  id: r.id,
  target: {
    kind: r.target_kind,
    id: r.target_id,
    summary: r.summary,
    risk: r.risk,
    rollback: r.rollback,
  },
  status: r.status,
  tokenHash: r.token_hash,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
  ...(r.decided_by === null ? {} : { decidedBy: r.decided_by }),
});

export class PostgresApprovalRepository implements ApprovalRepository {
  constructor(private readonly pool: Pool) {}
  async create(r: ApprovalRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO approval_requests(id,target_kind,target_id,summary,risk,rollback,status,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)",
        [
          r.id,
          r.target.kind,
          r.target.id,
          r.target.summary,
          r.target.risk,
          r.target.rollback,
          r.tokenHash,
          r.expiresAt,
          r.createdAt,
        ],
      );
      await client.query(
        "INSERT INTO domain_events(id,event_type,aggregate_id,payload,occurred_at) VALUES($1,'approval.requested',$2,$3,$4)",
        [
          randomUUID(),
          r.id,
          { targetKind: r.target.kind, targetId: r.target.id },
          r.createdAt,
        ],
      );
      await client.query(
        "INSERT INTO audit_records(id,action,aggregate_id,actor,payload,occurred_at) VALUES($1,'approval.requested',$2,'system','{}',$3)",
        [randomUUID(), r.id, r.createdAt],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async decide(
    i: DecisionInput,
    chat: string,
    user: string,
  ): Promise<DecisionResult> {
    if (i.chatId !== chat || i.userId !== user)
      return { outcome: "unauthorized" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Row>(
        "SELECT *, expires_at <= CURRENT_TIMESTAMP AS expired FROM approval_requests WHERE token_hash=$1 FOR UPDATE",
        [i.tokenHash],
      );
      const row = current.rows[0];
      if (row === undefined) {
        await client.query("ROLLBACK");
        return { outcome: "invalid" };
      }
      if (row.status !== "pending") {
        await client.query("ROLLBACK");
        return { outcome: "replayed" };
      }
      if (row.expired === true) {
        await client.query("ROLLBACK");
        return { outcome: "expired" };
      }
      const updated = await client.query<Row>(
        "UPDATE approval_requests SET status=$1,decided_at=$2,decided_by=$3 WHERE id=$4 AND status='pending' RETURNING *",
        [i.decision, i.now, i.userId, row.id],
      );
      await client.query(
        "INSERT INTO domain_events(id,event_type,aggregate_id,payload,occurred_at) VALUES($1,$2,$3,'{}',$4)",
        [randomUUID(), `approval.${i.decision}`, row.id, i.now],
      );
      await client.query(
        "INSERT INTO audit_records(id,action,aggregate_id,actor,payload,occurred_at) VALUES($1,$2,$3,$4,'{}',$5)",
        [randomUUID(), `approval.${i.decision}`, row.id, i.userId, i.now],
      );
      await client.query("COMMIT");
      return { outcome: "decided", approval: map(updated.rows[0]!) };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async find(id: string): Promise<ApprovalRecord | undefined> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM approval_requests WHERE id=$1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : map(row);
  }
  async list(limit = 100): Promise<ApprovalRecord[]> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return result.rows.map(map);
  }
}
