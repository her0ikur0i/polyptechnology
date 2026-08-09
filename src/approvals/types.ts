export type ApprovalDecision = "approved" | "denied";
export type ApprovalStatus = "pending" | ApprovalDecision;

export interface ApprovalTarget {
  kind: string;
  id: string;
  summary: string;
  risk: string;
  rollback: string;
}

export interface ApprovalRecord {
  id: string;
  target: ApprovalTarget;
  status: ApprovalStatus;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  decidedAt?: Date;
  decidedBy?: string;
}

export interface DecisionInput {
  tokenHash: string;
  decision: ApprovalDecision;
  chatId: string;
  userId: string;
  now: Date;
}

export type DecisionResult =
  | { outcome: "decided"; approval: ApprovalRecord }
  | { outcome: "invalid" | "expired" | "replayed" | "unauthorized" };

export interface ApprovalRepository {
  create(record: ApprovalRecord): Promise<void>;
  decide(
    input: DecisionInput,
    authorizedChatId: string,
    authorizedUserId: string,
  ): Promise<DecisionResult>;
  find(id: string): Promise<ApprovalRecord | undefined>;
}
