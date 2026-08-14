export type Classification = "public" | "internal" | "confidential" | "secret";
export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  version: number;
  createdAt: Date;
  archivedAt?: Date;
}
export interface Message {
  id: string;
  conversationId: string;
  projectId: string;
  ordinal: number;
  role: "owner" | "assistant" | "system";
  content: string;
  classification: Classification;
  contentSha256: string;
  createdAt: Date;
  sourceTaskId?: string;
  modelAttribution?: {
    provider: string;
    requestedModelId: string;
    resolvedModelId?: string;
    costUsdMicros: number;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
  };
}
export type AttachmentState =
  | "quarantined"
  | "validated"
  | "scanned"
  | "classified"
  | "redacted"
  | "rejected";
export interface Attachment {
  id: string;
  conversationId: string;
  projectId: string;
  objectKey: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  state: AttachmentState;
  classification?: Classification;
  safeText?: string;
}
export type ProposalState =
  "draft" | "owner_review" | "approved" | "rejected" | "handed_off";
export interface Proposal {
  id: string;
  conversationId: string;
  projectId: string;
  version: number;
  state: ProposalState;
  contractCandidate: string;
  candidateSha256: string;
  approvalId?: string;
}
export interface ContextItem {
  kind: "message" | "attachment";
  sourceId: string;
  classification: Exclude<Classification, "secret">;
  content: string;
  sha256: string;
}
export interface ContextManifest {
  conversationId: string;
  projectId: string;
  conversationVersion: number;
  items: ReadonlyArray<ContextItem>;
  totalBytes: number;
  manifestSha256: string;
}
export interface ConversationStore {
  createConversation(
    value: Conversation,
    idempotencyKey: string,
  ): Promise<Conversation>;
  appendMessage(
    value: Omit<Message, "ordinal">,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<Message>;
  conversation(
    projectId: string,
    id: string,
  ): Promise<Conversation | undefined>;
  listConversations(
    projectId: string,
    options?: { search?: string; includeArchived?: boolean },
  ): Promise<ReadonlyArray<Conversation>>;
  renameConversation(
    projectId: string,
    id: string,
    title: string,
    expectedVersion: number,
  ): Promise<Conversation>;
  setConversationArchived(
    projectId: string,
    id: string,
    archived: boolean,
    expectedVersion: number,
  ): Promise<Conversation>;
  messages(
    projectId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<Message>>;
  putAttachment(value: Attachment, idempotencyKey: string): Promise<Attachment>;
  transitionAttachment(
    projectId: string,
    attachmentId: string,
    from: AttachmentState,
    to: AttachmentState,
    evidenceSha256: string,
    classification?: Classification,
    safeText?: string,
  ): Promise<Attachment>;
  attachments(
    projectId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<Attachment>>;
  saveContextManifest(value: ContextManifest): Promise<ContextManifest>;
  contextManifest(
    projectId: string,
    digest: string,
  ): Promise<ContextManifest | undefined>;
  createProposal(value: Proposal, idempotencyKey: string): Promise<Proposal>;
  transitionProposal(
    projectId: string,
    id: string,
    expectedVersion: number,
    to: ProposalState,
    approvalId?: string,
  ): Promise<Proposal>;
  proposal(projectId: string, id: string): Promise<Proposal | undefined>;
}
