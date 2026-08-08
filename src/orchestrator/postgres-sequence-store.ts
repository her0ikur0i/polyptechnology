import type { Pool } from "pg";
import type {
  SequenceCheckpoint,
  SequenceStore,
  SupervisorLease,
} from "./supervisor.js";
export class PostgresSequenceStore implements SequenceStore {
  constructor(private readonly pool: Pool) {}
  async claim(owner: string, ttlMs: number) {
    if (!owner || !Number.isSafeInteger(ttlMs) || ttlMs < 1000)
      throw new Error("invalid supervisor lease");
    const result = await this.pool.query<{
      fencing_token: string;
      lease_expires_at: Date;
    }>(
      "UPDATE sequence_supervisor SET lease_owner=$1,fencing_token=nextval('task_fencing_token_seq'),heartbeat_at=CURRENT_TIMESTAMP,lease_expires_at=CURRENT_TIMESTAMP+($2*interval '1 millisecond') WHERE singleton AND roadmap_state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=CURRENT_TIMESTAMP) RETURNING fencing_token,lease_expires_at",
      [owner, ttlMs],
    );
    if (result.rowCount !== 1) throw new Error("sequence lease unavailable");
    return {
      owner,
      fencingToken: Number(result.rows[0]!.fencing_token),
      expiresAt: result.rows[0]!.lease_expires_at,
    };
  }
  async heartbeat(lease: SupervisorLease, ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000)
      throw new Error("invalid supervisor lease");
    const result = await this.pool.query<{ lease_expires_at: Date }>(
      "UPDATE sequence_supervisor SET heartbeat_at=CURRENT_TIMESTAMP,lease_expires_at=CURRENT_TIMESTAMP+($3*interval '1 millisecond') WHERE singleton AND lease_owner=$1 AND fencing_token=$2 AND lease_expires_at>CURRENT_TIMESTAMP RETURNING lease_expires_at",
      [lease.owner, lease.fencingToken, ttlMs],
    );
    if (result.rowCount !== 1) throw new Error("stale sequence lease");
    return { ...lease, expiresAt: result.rows[0]!.lease_expires_at };
  }
  async checkpoint(lease: SupervisorLease, value: SequenceCheckpoint) {
    if (
      !/^CONTRACT-[0-9]{3}$/.test(value.contractId) ||
      !/^M[0-9]+$/.test(value.milestoneId) ||
      value.phase.length === 0 ||
      value.phase.length > 100 ||
      value.evidenceIds.length === 0 ||
      value.evidenceIds.some((id) => !/^[a-zA-Z0-9:_-]{1,200}$/.test(id))
    )
      throw new Error("checkpoint evidence required");
    const result = await this.pool.query(
      "UPDATE sequence_supervisor SET active_contract=$3,active_milestone=$4,checkpoint=$5,version=version+1 WHERE singleton AND lease_owner=$1 AND fencing_token=$2 AND lease_expires_at>CURRENT_TIMESTAMP",
      [
        lease.owner,
        lease.fencingToken,
        value.contractId,
        value.milestoneId,
        value,
      ],
    );
    if (result.rowCount !== 1) throw new Error("stale sequence lease");
  }
  async release(lease: SupervisorLease) {
    await this.pool.query(
      "UPDATE sequence_supervisor SET lease_owner=NULL,fencing_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL WHERE singleton AND lease_owner=$1 AND fencing_token=$2",
      [lease.owner, lease.fencingToken],
    );
  }
}
