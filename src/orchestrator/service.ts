import { createHash, randomUUID } from "node:crypto";
import type { ConversationStore, Proposal } from "./types.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export class OrchestratorService {
  constructor(private readonly store: ConversationStore) {}
  async submitProposal(input: {
    projectId: string;
    conversationId: string;
    contractCandidate: string;
    idempotencyKey: string;
  }) {
    const conversation = await this.store.conversation(
      input.projectId,
      input.conversationId,
    );
    if (!conversation) throw new Error("conversation not found");
    if (input.contractCandidate.trim().length === 0)
      throw new Error("empty contract candidate");
    const proposal: Proposal = {
      id: randomUUID(),
      projectId: input.projectId,
      conversationId: input.conversationId,
      version: 1,
      state: "draft",
      contractCandidate: input.contractCandidate,
      candidateSha256: sha(input.contractCandidate),
    };
    return this.store.createProposal(proposal, input.idempotencyKey);
  }
  async requestOwnerReview(
    projectId: string,
    proposalId: string,
    version: number,
  ) {
    return this.store.transitionProposal(
      projectId,
      proposalId,
      version,
      "owner_review",
    );
  }
  async approve(
    projectId: string,
    proposalId: string,
    version: number,
    approvalId: string,
  ) {
    if (!approvalId) throw new Error("approval reference required");
    return this.store.transitionProposal(
      projectId,
      proposalId,
      version,
      "approved",
      approvalId,
    );
  }
  async reject(projectId: string, proposalId: string, version: number) {
    return this.store.transitionProposal(
      projectId,
      proposalId,
      version,
      "rejected",
    );
  }
  async handoff(projectId: string, proposalId: string, version: number) {
    const value = await this.store.transitionProposal(
      projectId,
      proposalId,
      version,
      "handed_off",
    );
    if (!value.approvalId) throw new Error("approved proposal required");
    return Object.freeze({
      proposalId: value.id,
      projectId: value.projectId,
      conversationId: value.conversationId,
      approvalId: value.approvalId,
      contractCandidate: value.contractCandidate,
      candidateSha256: value.candidateSha256,
    });
  }
}
