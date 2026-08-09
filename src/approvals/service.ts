import { randomUUID } from "node:crypto";
import {
  generateApprovalToken,
  hashApprovalToken,
  parseApprovalToken,
} from "./token.js";
import type {
  ApprovalDecision,
  ApprovalRepository,
  ApprovalTarget,
  DecisionResult,
} from "./types.js";

export class ApprovalService {
  constructor(
    private readonly repository: ApprovalRepository,
    private readonly chatId: string,
    private readonly userId: string,
  ) {}

  async request(
    target: ApprovalTarget,
    ttlMs: number,
    now = new Date(),
  ): Promise<{ approvalId: string; token: string }> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000)
      throw new Error("approval TTL must be between 1 second and 24 hours");
    const token = generateApprovalToken();
    const id = randomUUID();
    await this.repository.create({
      id,
      target: { ...target },
      status: "pending",
      tokenHash: hashApprovalToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    });
    return { approvalId: id, token };
  }

  async decide(
    tokenValue: string,
    decision: ApprovalDecision,
    chatId: string,
    userId: string,
    now = new Date(),
  ): Promise<DecisionResult> {
    const token = parseApprovalToken(tokenValue);
    if (token === undefined) return { outcome: "invalid" };
    return this.repository.decide(
      { tokenHash: hashApprovalToken(token), decision, chatId, userId, now },
      this.chatId,
      this.userId,
    );
  }
}
