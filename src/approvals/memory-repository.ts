import type { ApprovalRecord, ApprovalRepository, DecisionInput, DecisionResult } from "./types.js";

function copy(record: ApprovalRecord): ApprovalRecord {
  return { ...record, target: { ...record.target }, expiresAt: new Date(record.expiresAt), createdAt: new Date(record.createdAt), ...(record.decidedAt === undefined ? {} : { decidedAt: new Date(record.decidedAt) }) };
}

export class MemoryApprovalRepository implements ApprovalRepository {
  readonly events: ReadonlyArray<Record<string, unknown>> = [];
  readonly audit: ReadonlyArray<Record<string, unknown>> = [];
  private readonly records = new Map<string, ApprovalRecord>();

  async create(record: ApprovalRecord): Promise<void> {
    if ([...this.records.values()].some((item) => item.tokenHash === record.tokenHash)) throw new Error("duplicate approval token hash");
    this.records.set(record.id, copy(record));
    (this.events as Record<string, unknown>[]).push({ type: "approval.requested", approvalId: record.id, targetKind: record.target.kind, targetId: record.target.id });
    (this.audit as Record<string, unknown>[]).push({ action: "approval.requested", approvalId: record.id });
  }

  async decide(input: DecisionInput, authorizedChatId: string, authorizedUserId: string): Promise<DecisionResult> {
    if (input.chatId !== authorizedChatId || input.userId !== authorizedUserId) return { outcome: "unauthorized" };
    const record = [...this.records.values()].find((item) => item.tokenHash === input.tokenHash);
    if (record === undefined) return { outcome: "invalid" };
    if (record.status !== "pending") return { outcome: "replayed" };
    if (record.expiresAt.getTime() <= input.now.getTime()) return { outcome: "expired" };
    record.status = input.decision;
    record.decidedAt = new Date(input.now);
    record.decidedBy = input.userId;
    (this.events as Record<string, unknown>[]).push({ type: `approval.${input.decision}`, approvalId: record.id });
    (this.audit as Record<string, unknown>[]).push({ action: `approval.${input.decision}`, approvalId: record.id, actor: input.userId });
    return { outcome: "decided", approval: copy(record) };
  }

  async find(id: string): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    return record === undefined ? undefined : copy(record);
  }
}
