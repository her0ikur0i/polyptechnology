import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { KnowledgeAuthority, KnowledgeItem, PurgePlan } from "./types.js";

export class PostgresKnowledgeRepository {
  constructor(private readonly pool: Pool) {}
  async add(item: KnowledgeItem) {
    await this.pool.query(
      "INSERT INTO knowledge_items(id,version,title,body,status,classification,scope_kind,scope_id,source_type,source_ref,source_sha256,license,confidence_permille,dependencies,verification_evidence,supersedes_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
      [
        item.id,
        item.version,
        item.title,
        item.body,
        item.status,
        item.classification,
        item.scope.kind,
        item.scope.scopeId,
        item.sourceType,
        item.sourceRef,
        item.sourceSha256,
        item.license,
        item.confidencePermille,
        JSON.stringify(item.dependencies),
        JSON.stringify(item.verificationEvidence),
        item.supersedesId ?? null,
        item.createdAt,
      ],
    );
    return item;
  }
  async retrieve(
    query: string,
    authority: KnowledgeAuthority,
    limit = 20,
  ): Promise<KnowledgeItem[]> {
    if (
      query.trim().length < 2 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("invalid knowledge query");
    const result = await this.pool.query(
      "SELECT k.* FROM knowledge_items k WHERE k.status='reusable' AND NOT EXISTS(SELECT 1 FROM knowledge_purge_plans p WHERE p.source_item_id=k.id) AND k.search_vector @@ plainto_tsquery('simple',$1) AND ((k.scope_kind='global' AND k.classification='public' AND $2) OR (k.scope_kind='organization' AND k.scope_id=$3 AND k.classification<>'private') OR (k.scope_kind='project' AND k.scope_id=ANY($4::text[])) OR (k.scope_kind='contract' AND k.scope_id=ANY($5::text[])) OR (k.scope_kind='session' AND k.scope_id=ANY($6::text[])) OR (k.scope_kind='private' AND k.scope_id=$7)) ORDER BY ts_rank(k.search_vector,plainto_tsquery('simple',$1)) DESC,k.confidence_permille DESC,k.id LIMIT $8",
      [
        query,
        authority.allowGlobal,
        authority.organizationId,
        authority.projectIds,
        authority.contractIds,
        authority.sessionIds,
        authority.privatePrincipalId ?? "",
        limit,
      ],
    );
    return result.rows.map(item);
  }
  async transition(
    id: string,
    expectedVersion: number,
    to: KnowledgeItem["status"],
    evidenceSha256: string,
    occurredAt: string,
  ) {
    const allowed: Record<
      KnowledgeItem["status"],
      ReadonlyArray<KnowledgeItem["status"]>
    > = {
      candidate: ["verified", "deprecated"],
      verified: ["curated", "deprecated"],
      curated: ["reusable", "deprecated"],
      reusable: ["deprecated", "superseded"],
      deprecated: [],
      superseded: [],
    };
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256))
      throw new Error("invalid knowledge evidence");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM knowledge_items WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (result.rowCount !== 1) throw new Error("knowledge item missing");
      const current = item(result.rows[0] as ItemRow);
      if (current.version !== expectedVersion)
        throw new Error("stale knowledge fence");
      if (!allowed[current.status].includes(to))
        throw new Error("illegal knowledge transition");
      if (
        ["verified", "curated", "reusable"].includes(to) &&
        current.verificationEvidence.length === 0
      )
        throw new Error("verification evidence required");
      if (
        to === "reusable" &&
        (current.classification === "private" ||
          current.scope.kind === "private")
      )
        throw new Error("private knowledge cannot become reusable");
      const version = current.version + 1;
      await client.query(
        "UPDATE knowledge_items SET status=$2,version=$3 WHERE id=$1 AND version=$4",
        [id, to, version, expectedVersion],
      );
      await client.query(
        "INSERT INTO knowledge_status_events(id,knowledge_id,from_status,to_status,resulting_version,evidence_sha256,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          id,
          current.status,
          to,
          version,
          evidenceSha256,
          occurredAt,
        ],
      );
      await client.query("COMMIT");
      return { ...current, status: to, version };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async preparePurge(
    sourceItemId: string,
    createdAt: string,
  ): Promise<PurgePlan> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await client.query<PurgeRow>(
        "SELECT * FROM knowledge_purge_plans WHERE source_item_id=$1 FOR UPDATE",
        [sourceItemId],
      );
      if (replay.rowCount === 1) {
        await client.query("COMMIT");
        return purge(replay.rows[0]!);
      }
      const source = await client.query(
        "SELECT source_sha256 FROM knowledge_items WHERE id=$1 FOR UPDATE",
        [sourceItemId],
      );
      if (source.rowCount !== 1) throw new Error("knowledge item missing");
      const indexes = await client.query<{ id: string }>(
        "SELECT id FROM knowledge_derived_indexes WHERE source_item_id=$1 AND state='active' ORDER BY id FOR UPDATE",
        [sourceItemId],
      );
      const ids = indexes.rows.map((row) => row.id),
        sourceSha256 = String(source.rows[0].source_sha256),
        planSha256 = createHash("sha256")
          .update(`${sourceItemId}\0${sourceSha256}\0${ids.join("\0")}`)
          .digest("hex"),
        id = randomUUID();
      await client.query(
        "UPDATE knowledge_derived_indexes SET state='purge_pending' WHERE source_item_id=$1 AND state='active'",
        [sourceItemId],
      );
      await client.query(
        "INSERT INTO knowledge_purge_plans(id,source_item_id,source_sha256,derived_index_ids,plan_sha256,state,created_at) VALUES($1,$2,$3,$4,$5,'prepared',$6)",
        [
          id,
          sourceItemId,
          sourceSha256,
          JSON.stringify(ids),
          planSha256,
          createdAt,
        ],
      );
      await client.query("COMMIT");
      return {
        id,
        sourceItemId,
        sourceSha256,
        derivedIndexIds: ids,
        planSha256,
        createdAt,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
type ItemRow = {
  id: string;
  version: number;
  title: string;
  body: string;
  status: KnowledgeItem["status"];
  classification: KnowledgeItem["classification"];
  scope_kind: KnowledgeItem["scope"]["kind"];
  scope_id: string;
  source_type: KnowledgeItem["sourceType"];
  source_ref: string;
  source_sha256: string;
  license: string;
  confidence_permille: number;
  dependencies: string[];
  verification_evidence: string[];
  supersedes_id: string | null;
  created_at: Date;
};
type PurgeRow = {
  id: string;
  source_item_id: string;
  source_sha256: string;
  derived_index_ids: string[];
  plan_sha256: string;
  created_at: Date;
};
const item = (row: ItemRow): KnowledgeItem => ({
  id: row.id,
  version: row.version,
  title: row.title,
  body: row.body,
  status: row.status,
  classification: row.classification,
  scope: { kind: row.scope_kind, scopeId: row.scope_id },
  sourceType: row.source_type,
  sourceRef: row.source_ref,
  sourceSha256: row.source_sha256,
  license: row.license,
  confidencePermille: row.confidence_permille,
  dependencies: row.dependencies,
  verificationEvidence: row.verification_evidence,
  ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
  createdAt: row.created_at.toISOString(),
});
const purge = (row: PurgeRow): PurgePlan => ({
  id: row.id,
  sourceItemId: row.source_item_id,
  sourceSha256: row.source_sha256,
  derivedIndexIds: row.derived_index_ids,
  planSha256: row.plan_sha256,
  createdAt: row.created_at.toISOString(),
});
