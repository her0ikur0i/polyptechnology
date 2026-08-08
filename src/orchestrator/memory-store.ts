import type {
  Attachment,
  Conversation,
  ConversationStore,
  Message,
  Proposal,
  ProposalState,
} from "./types.js";
import { advanceAttachment } from "./attachments.js";
const clone = <T>(value: T): T => structuredClone(value);
export class MemoryConversationStore implements ConversationStore {
  private conversations = new Map<string, Conversation>();
  private messageRows = new Map<string, Message[]>();
  private attachmentRows = new Map<string, Attachment[]>();
  private proposals = new Map<string, Proposal>();
  private manifests = new Map<string, import("./types.js").ContextManifest>();
  private replay = new Map<string, unknown>();
  async createConversation(value: Conversation, key: string) {
    return this.idempotent(`conversation:${key}`, value, () => {
      if (this.conversations.has(value.id))
        throw new Error("conversation exists");
      this.conversations.set(value.id, clone(value));
      return value;
    });
  }
  async appendMessage(
    value: Omit<Message, "ordinal">,
    expectedVersion: number,
    key: string,
  ) {
    return this.idempotent(
      `message:${value.conversationId}:${key}`,
      value,
      () => {
        const conversation = this.requireConversation(
          value.projectId,
          value.conversationId,
        );
        if (conversation.version !== expectedVersion)
          throw new Error("stale conversation version");
        const rows = this.messageRows.get(value.conversationId) ?? [];
        const message = { ...value, ordinal: rows.length + 1 };
        rows.push(clone(message));
        this.messageRows.set(value.conversationId, rows);
        conversation.version++;
        return message;
      },
    );
  }
  async conversation(projectId: string, id: string) {
    const value = this.conversations.get(id);
    return value?.projectId === projectId ? clone(value) : undefined;
  }
  async messages(projectId: string, id: string) {
    this.requireConversation(projectId, id);
    return clone(this.messageRows.get(id) ?? []);
  }
  async putAttachment(value: Attachment, key: string) {
    return this.idempotent(
      `attachment:${value.conversationId}:${key}`,
      value,
      () => {
        this.requireConversation(value.projectId, value.conversationId);
        const rows = this.attachmentRows.get(value.conversationId) ?? [];
        if (rows.some((row) => row.id === value.id))
          throw new Error("attachment exists");
        rows.push(clone(value));
        this.attachmentRows.set(value.conversationId, rows);
        return value;
      },
    );
  }
  async attachments(projectId: string, id: string) {
    this.requireConversation(projectId, id);
    return clone(this.attachmentRows.get(id) ?? []);
  }
  async transitionAttachment(
    projectId: string,
    attachmentId: string,
    from: Attachment["state"],
    to: Attachment["state"],
    evidenceSha256: string,
    classification?: Attachment["classification"],
    safeText?: string,
  ) {
    for (const rows of this.attachmentRows.values()) {
      const index = rows.findIndex(
        (row) => row.id === attachmentId && row.projectId === projectId,
      );
      if (index >= 0) {
        const current = rows[index]!;
        if (current.state !== from) throw new Error("stale attachment state");
        const next = advanceAttachment(current, to, {
          evidenceSha256,
          ...(classification ? { classification } : {}),
          ...(safeText !== undefined ? { safeText } : {}),
        });
        rows[index] = next;
        return clone(next);
      }
    }
    throw new Error("attachment not found");
  }
  async saveContextManifest(value: import("./types.js").ContextManifest) {
    const existing = this.manifests.get(value.manifestSha256);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value))
      throw new Error("manifest digest collision");
    this.requireConversation(value.projectId, value.conversationId);
    this.manifests.set(value.manifestSha256, clone(value));
    return clone(value);
  }
  async contextManifest(projectId: string, digest: string) {
    const value = this.manifests.get(digest);
    return value?.projectId === projectId ? clone(value) : undefined;
  }
  async createProposal(value: Proposal, key: string) {
    return this.idempotent(
      `proposal:${value.conversationId}:${key}`,
      value,
      () => {
        this.requireConversation(value.projectId, value.conversationId);
        this.proposals.set(value.id, clone(value));
        return value;
      },
    );
  }
  async transitionProposal(
    projectId: string,
    id: string,
    expectedVersion: number,
    to: ProposalState,
    approvalId?: string,
  ) {
    const value = this.proposals.get(id);
    if (!value || value.projectId !== projectId)
      throw new Error("proposal not found");
    if (value.version !== expectedVersion)
      throw new Error("stale proposal version");
    const allowed: Record<ProposalState, ProposalState[]> = {
      draft: ["owner_review"],
      owner_review: ["approved", "rejected"],
      approved: ["handed_off"],
      rejected: [],
      handed_off: [],
    };
    if (!allowed[value.state].includes(to))
      throw new Error("invalid proposal transition");
    if (to === "approved" && !approvalId)
      throw new Error("approval reference required");
    const next = {
      ...value,
      state: to,
      version: value.version + 1,
      ...(approvalId ? { approvalId } : {}),
    };
    this.proposals.set(id, next);
    return clone(next);
  }
  async proposal(projectId: string, id: string) {
    const value = this.proposals.get(id);
    return value?.projectId === projectId ? clone(value) : undefined;
  }
  private requireConversation(projectId: string, id: string) {
    const value = this.conversations.get(id);
    if (!value || value.projectId !== projectId)
      throw new Error("conversation not found");
    return value;
  }
  private async idempotent<T>(
    key: string,
    intent: unknown,
    operation: () => T,
  ) {
    const fingerprint = JSON.stringify(intent);
    if (this.replay.has(key)) {
      const old = this.replay.get(key) as { fingerprint: string; result: T };
      if (old.fingerprint !== fingerprint)
        throw new Error("idempotency intent mismatch");
      return clone(old.result);
    }
    const result = operation();
    this.replay.set(key, { fingerprint, result: clone(result) });
    return clone(result);
  }
}
