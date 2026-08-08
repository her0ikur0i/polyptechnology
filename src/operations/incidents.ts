import { createHash } from "node:crypto";
import type { Pool } from "pg";
export type IncidentState = "new" | "seen" | "acknowledged" | "resolved";
export class PostgresIncidentService {
  constructor(private readonly pool: Pool) {}
  async report(
    kind: string,
    deduplicationKey: string,
    sourceHref: string,
    details: unknown,
    occurredAt: string,
  ) {
    if (
      !/^[a-z][a-z0-9_.-]{1,80}$/.test(kind) ||
      !sourceHref.startsWith("/") ||
      sourceHref.startsWith("//")
    )
      throw new Error("invalid incident");
    const fingerprint = createHash("sha256")
      .update(`${kind}\0${deduplicationKey}`)
      .digest("hex");
    const result = await this.pool.query(
      "INSERT INTO operational_incidents(fingerprint,kind,state,source_href,details,first_seen_at,last_seen_at) VALUES($1,$2,'new',$3,$4,$5,$5) ON CONFLICT(fingerprint) DO UPDATE SET occurrence_count=operational_incidents.occurrence_count+1,last_seen_at=EXCLUDED.last_seen_at,state=CASE WHEN operational_incidents.state='resolved' THEN 'new' ELSE operational_incidents.state END,resolved_at=NULL RETURNING *",
      [fingerprint, kind, sourceHref, details, occurredAt],
    );
    return result.rows[0] as {
      fingerprint: string;
      state: IncidentState;
      occurrence_count: string;
    };
  }
  async transition(
    fingerprint: string,
    from: IncidentState,
    to: IncidentState,
    actorId: string,
    occurredAt: string,
  ) {
    const allowed: Record<IncidentState, ReadonlyArray<IncidentState>> = {
      new: ["seen", "acknowledged"],
      seen: ["acknowledged", "resolved"],
      acknowledged: ["resolved"],
      resolved: [],
    };
    if (!allowed[from].includes(to) || actorId.length === 0)
      throw new Error("invalid incident transition");
    const result = await this.pool.query(
      "UPDATE operational_incidents SET state=$3,owner_id=$4,acknowledged_at=CASE WHEN $3='acknowledged' THEN $5::timestamptz ELSE acknowledged_at END,resolved_at=CASE WHEN $3='resolved' THEN $5::timestamptz ELSE NULL END WHERE fingerprint=$1 AND state=$2 RETURNING *",
      [fingerprint, from, to, actorId, occurredAt],
    );
    if (result.rowCount !== 1) throw new Error("stale incident state");
    return result.rows[0] as { fingerprint: string; state: IncidentState };
  }
}
