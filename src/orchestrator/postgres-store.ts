import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type {
  Attachment,
  Conversation,
  ConversationStore,
  ContextManifest,
  Message,
  Proposal,
  ProposalState,
} from "./types.js";
import { advanceAttachment } from "./attachments.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conversation = (row: {
  id: string;
  project_id: string;
  title: string;
  version: string;
  created_at: Date;
  archived_at?: Date | null;
}): Conversation => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  version: Number(row.version),
  createdAt: row.created_at,
  ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
});
const message = (row: {
  id: string;
  conversation_id: string;
  project_id: string;
  ordinal: string;
  role: Message["role"];
  content: string;
  classification: Message["classification"];
  content_sha256: string;
  created_at: Date;
}): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  projectId: row.project_id,
  ordinal: Number(row.ordinal),
  role: row.role,
  content: row.content,
  classification: row.classification,
  contentSha256: row.content_sha256,
  createdAt: row.created_at,
});
type AttachmentRow = {
  id: string;
  conversation_id: string;
  project_id: string;
  object_key: string;
  display_name: string;
  media_type: string;
  size_bytes: string;
  sha256: string;
  state: Attachment["state"];
  classification: Attachment["classification"] | null;
  safe_text: string | null;
};
type ProposalRow = {
  id: string;
  conversation_id: string;
  project_id: string;
  version: string;
  state: Proposal["state"];
  contract_candidate: string;
  candidate_sha256: string;
  approval_id: string | null;
};
const attachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  conversationId: row.conversation_id,
  projectId: row.project_id,
  objectKey: row.object_key,
  displayName: row.display_name,
  mediaType: row.media_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
  state: row.state,
  ...(row.classification ? { classification: row.classification } : {}),
  ...(row.safe_text !== null ? { safeText: row.safe_text } : {}),
});
const proposal = (row: ProposalRow): Proposal => ({
  id: row.id,
  conversationId: row.conversation_id,
  projectId: row.project_id,
  version: Number(row.version),
  state: row.state,
  contractCandidate: row.contract_candidate,
  candidateSha256: row.candidate_sha256,
  ...(row.approval_id ? { approvalId: row.approval_id } : {}),
});
export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly pool: Pool) {}
  async createConversation(value: Conversation, key: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await this.reserve(
        client,
        `conversation:${value.projectId}`,
        key,
        value,
        value.id,
      );
      if (!replay) {
        await client.query(
          "INSERT INTO conversations(id,project_id,title,version,created_at) VALUES($1,$2,$3,$4,$5)",
          [
            value.id,
            value.projectId,
            value.title,
            value.version,
            value.createdAt,
          ],
        );
      }
      const result = await client.query(
        "SELECT * FROM conversations WHERE id=$1 AND project_id=$2",
        [value.id, value.projectId],
      );
      await client.query("COMMIT");
      return conversation(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async appendMessage(
    value: Omit<Message, "ordinal">,
    expectedVersion: number,
    key: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scope = `message:${value.projectId}:${value.conversationId}`,
        intent = { ...value, expectedVersion };
      const existing = await this.idempotency(client, scope, key, intent);
      if (existing) {
        const row = await client.query(
          "SELECT * FROM conversation_messages WHERE id=$1",
          [existing],
        );
        await client.query("COMMIT");
        return message(row.rows[0]);
      }
      const changed = await client.query<{ version: string }>(
        "UPDATE conversations SET version=version+1 WHERE id=$1 AND project_id=$2 AND version=$3 RETURNING version",
        [value.conversationId, value.projectId, expectedVersion],
      );
      if (changed.rowCount !== 1) throw new Error("stale conversation version");
      const ordinal = Number(changed.rows[0]!.version);
      await client.query(
        "INSERT INTO conversation_messages(id,conversation_id,project_id,ordinal,role,content,classification,content_sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          value.id,
          value.conversationId,
          value.projectId,
          ordinal,
          value.role,
          value.content,
          value.classification,
          value.contentSha256,
          value.createdAt,
        ],
      );
      await this.insertIdempotency(client, scope, key, intent, value.id);
      await client.query("COMMIT");
      return { ...value, ordinal };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async conversation(projectId: string, id: string) {
    const result = await this.pool.query(
      "SELECT * FROM conversations WHERE id=$1 AND project_id=$2",
      [id, projectId],
    );
    return result.rowCount ? conversation(result.rows[0]) : undefined;
  }
  async listConversations(
    projectId: string,
    options?: { search?: string; includeArchived?: boolean },
  ) {
    const includeArchived = options?.includeArchived ?? false;
    const search = options?.search?.trim();
    const result = await this.pool.query(
      `SELECT * FROM conversations
       WHERE project_id=$1
         AND ($2 OR archived_at IS NULL)
         AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%')
       ORDER BY created_at DESC, id`,
      [projectId, includeArchived, search && search.length > 0 ? search : null],
    );
    return result.rows.map(conversation);
  }
  async renameConversation(
    projectId: string,
    id: string,
    title: string,
    expectedVersion: number,
  ) {
    const result = await this.pool.query(
      "UPDATE conversations SET title=$4, version=version+1 WHERE id=$1 AND project_id=$2 AND version=$3 RETURNING *",
      [id, projectId, expectedVersion, title],
    );
    if (result.rowCount !== 1) throw new Error("stale conversation version");
    return conversation(result.rows[0]);
  }
  async setConversationArchived(
    projectId: string,
    id: string,
    archived: boolean,
    expectedVersion: number,
  ) {
    const result = await this.pool.query(
      "UPDATE conversations SET archived_at=$4, version=version+1 WHERE id=$1 AND project_id=$2 AND version=$3 RETURNING *",
      [id, projectId, expectedVersion, archived ? new Date() : null],
    );
    if (result.rowCount !== 1) throw new Error("stale conversation version");
    return conversation(result.rows[0]);
  }
  async messages(projectId: string, id: string) {
    const result = await this.pool.query(
      "SELECT m.* FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id AND c.project_id=m.project_id WHERE m.conversation_id=$1 AND m.project_id=$2 ORDER BY ordinal",
      [id, projectId],
    );
    return result.rows.map(message);
  }
  async putAttachment(value: Attachment, key: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scope = `attachment:${value.projectId}:${value.conversationId}`;
      const replay = await this.reserve(client, scope, key, value, value.id);
      if (!replay)
        await client.query(
          "INSERT INTO conversation_attachments(id,conversation_id,project_id,object_key,display_name,media_type,size_bytes,sha256,state,classification,safe_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            value.id,
            value.conversationId,
            value.projectId,
            value.objectKey,
            value.displayName,
            value.mediaType,
            value.sizeBytes,
            value.sha256,
            value.state,
            value.classification ?? null,
            value.safeText ?? null,
          ],
        );
      if (!replay)
        await client.query(
          "INSERT INTO attachment_events(attachment_id,ordinal,from_state,to_state,evidence_sha256) VALUES($1,1,NULL,'quarantined',$2)",
          [value.id, value.sha256],
        );
      const result = await client.query(
        "SELECT * FROM conversation_attachments WHERE id=$1 AND project_id=$2",
        [value.id, value.projectId],
      );
      await client.query("COMMIT");
      return attachment(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async attachments(projectId: string, id: string) {
    const result = await this.pool.query(
      "SELECT * FROM conversation_attachments WHERE project_id=$1 AND conversation_id=$2 ORDER BY id",
      [projectId, id],
    );
    return result.rows.map(attachment);
  }
  async transitionAttachment(
    projectId: string,
    id: string,
    from: Attachment["state"],
    to: Attachment["state"],
    evidenceSha256: string,
    classification?: Attachment["classification"],
    safeText?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT * FROM conversation_attachments WHERE id=$1 AND project_id=$2 AND state=$3 FOR UPDATE",
        [id, projectId, from],
      );
      if (current.rowCount !== 1) throw new Error("stale attachment state");
      advanceAttachment(attachment(current.rows[0]), to, {
        evidenceSha256,
        ...(classification ? { classification } : {}),
        ...(safeText !== undefined ? { safeText } : {}),
      });
      const changed = await client.query(
        "UPDATE conversation_attachments SET state=$4,classification=COALESCE($5,classification),safe_text=COALESCE($6,safe_text) WHERE id=$1 AND project_id=$2 AND state=$3 RETURNING *",
        [id, projectId, from, to, classification ?? null, safeText ?? null],
      );
      await client.query(
        "INSERT INTO attachment_events(attachment_id,ordinal,from_state,to_state,evidence_sha256) SELECT $1,COALESCE(MAX(ordinal),0)+1,$2,$3,$4 FROM attachment_events WHERE attachment_id=$1",
        [id, from, to, evidenceSha256],
      );
      await client.query("COMMIT");
      return attachment(changed.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async saveContextManifest(value: ContextManifest) {
    const inserted = await this.pool.query(
      "INSERT INTO context_manifests(manifest_sha256,conversation_id,project_id,conversation_version,total_bytes,manifest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(manifest_sha256) DO NOTHING RETURNING manifest_sha256",
      [
        value.manifestSha256,
        value.conversationId,
        value.projectId,
        value.conversationVersion,
        value.totalBytes,
        value,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.contextManifest(
        value.projectId,
        value.manifestSha256,
      );
      if (existing === undefined || !isDeepStrictEqual(existing, value))
        throw new Error("manifest digest collision");
    }
    return value;
  }
  async contextManifest(projectId: string, digest: string) {
    const result = await this.pool.query<{ manifest: ContextManifest }>(
      "SELECT manifest FROM context_manifests WHERE project_id=$1 AND manifest_sha256=$2",
      [projectId, digest],
    );
    return result.rows[0]?.manifest;
  }
  async createProposal(value: Proposal, key: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scope = `proposal:${value.projectId}:${value.conversationId}`;
      const replay = await this.reserve(client, scope, key, value, value.id);
      if (!replay)
        await client.query(
          "INSERT INTO conversation_proposals(id,conversation_id,project_id,version,state,contract_candidate,candidate_sha256,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            value.id,
            value.conversationId,
            value.projectId,
            value.version,
            value.state,
            value.contractCandidate,
            value.candidateSha256,
            value.approvalId ?? null,
          ],
        );
      const result = await client.query(
        "SELECT * FROM conversation_proposals WHERE id=$1 AND project_id=$2",
        [value.id, value.projectId],
      );
      await client.query("COMMIT");
      return proposal(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async transitionProposal(
    projectId: string,
    id: string,
    version: number,
    to: ProposalState,
    approvalId?: string,
  ) {
    const allowed: Record<ProposalState, ProposalState[]> = {
      draft: ["owner_review"],
      owner_review: ["approved", "rejected"],
      approved: ["handed_off"],
      rejected: [],
      handed_off: [],
    };
    const current = await this.proposal(projectId, id);
    if (!current || !allowed[current.state].includes(to))
      throw new Error("invalid proposal transition");
    if (to === "approved" && !approvalId)
      throw new Error("approval reference required");
    const result = await this.pool.query(
      "UPDATE conversation_proposals SET state=$4,version=version+1,approval_id=COALESCE($5,approval_id) WHERE id=$1 AND project_id=$2 AND version=$3 RETURNING *",
      [id, projectId, version, to, approvalId ?? null],
    );
    if (result.rowCount !== 1) throw new Error("stale proposal version");
    return proposal(result.rows[0]);
  }
  async proposal(projectId: string, id: string) {
    const result = await this.pool.query(
      "SELECT * FROM conversation_proposals WHERE id=$1 AND project_id=$2",
      [id, projectId],
    );
    return result.rowCount ? proposal(result.rows[0]) : undefined;
  }
  private async idempotency(
    client: PoolClient,
    scope: string,
    key: string,
    intent: unknown,
  ) {
    const result = await client.query<{
      intent_sha256: string;
      resource_id: string;
    }>(
      "SELECT intent_sha256,resource_id FROM conversation_idempotency WHERE scope=$1 AND idempotency_key=$2 FOR UPDATE",
      [scope, key],
    );
    if (!result.rowCount) return undefined;
    if (result.rows[0]!.intent_sha256 !== hash(intent))
      throw new Error("idempotency intent mismatch");
    return result.rows[0]!.resource_id;
  }
  private async insertIdempotency(
    client: PoolClient,
    scope: string,
    key: string,
    intent: unknown,
    id: string,
  ) {
    await client.query(
      "INSERT INTO conversation_idempotency(scope,idempotency_key,intent_sha256,resource_id) VALUES($1,$2,$3,$4)",
      [scope, key, hash(intent), id],
    );
  }
  private async reserve(
    client: PoolClient,
    scope: string,
    key: string,
    intent: unknown,
    id: string,
  ) {
    const existing = await this.idempotency(client, scope, key, intent);
    if (existing && existing !== id)
      throw new Error("idempotency resource mismatch");
    if (!existing) await this.insertIdempotency(client, scope, key, intent, id);
    return existing;
  }
}
