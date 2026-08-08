import type {
  AttemptLedger,
  GatewayAttempt,
  ManagedCompletion,
} from "./types.js";
const clone = (attempt: GatewayAttempt): GatewayAttempt =>
  structuredClone(attempt);
export class MemoryAttemptLedger implements AttemptLedger {
  private readonly byId = new Map<string, GatewayAttempt>();
  private readonly byKey = new Map<string, string>();
  private readonly requestIds = new Set<string>();
  async reserve(attempt: GatewayAttempt) {
    const id = this.byKey.get(attempt.idempotencyKey);
    if (id !== undefined) {
      const existing = this.byId.get(id)!;
      if (existing.requestHash !== attempt.requestHash)
        throw new Error("idempotency intent mismatch");
      return { attempt: clone(existing), created: false };
    }
    this.byId.set(attempt.id, clone(attempt));
    this.byKey.set(attempt.idempotencyKey, attempt.id);
    return { attempt: clone(attempt), created: true };
  }
  async dispatched(attemptId: string) {
    const attempt = this.required(attemptId);
    if (attempt.outcome !== "reserved")
      throw new Error("attempt cannot dispatch");
    attempt.outcome = "dispatched";
  }
  async succeed(
    attemptId: string,
    result: ManagedCompletion,
    outputSha256: string,
  ) {
    const attempt = this.required(attemptId);
    if (attempt.outcome !== "dispatched")
      throw new Error("attempt cannot succeed");
    if (this.requestIds.has(result.providerRequestId))
      throw new Error("duplicate provider request id");
    this.requestIds.add(result.providerRequestId);
    Object.assign(attempt, {
      outcome: "succeeded" as const,
      providerRequestId: result.providerRequestId,
      resolvedModelId: result.resolvedModelId,
      resolutionSource: result.resolutionSource,
      usage: { ...result.usage },
      outputSha256,
      finalizedAt: new Date(),
    });
    return clone(attempt);
  }
  async reject(attemptId: string, result: ManagedCompletion, code: string) {
    const attempt = this.required(attemptId);
    if (attempt.outcome !== "dispatched")
      throw new Error("attempt cannot reject result");
    if (this.requestIds.has(result.providerRequestId))
      throw new Error("duplicate provider request id");
    this.requestIds.add(result.providerRequestId);
    Object.assign(attempt, {
      outcome: "failed" as const,
      providerRequestId: result.providerRequestId,
      resolvedModelId: result.resolvedModelId,
      resolutionSource: result.resolutionSource,
      usage: { ...result.usage },
      failureCode: code,
      finalizedAt: new Date(),
    });
    return clone(attempt);
  }
  async fail(
    attemptId: string,
    code: string,
    outcomeUnknown: boolean,
    providerRequestId?: string,
  ) {
    const attempt = this.required(attemptId);
    if (attempt.outcome !== "reserved" && attempt.outcome !== "dispatched")
      throw new Error("attempt already finalized");
    Object.assign(attempt, {
      outcome: outcomeUnknown
        ? ("outcome_unknown" as const)
        : ("failed" as const),
      failureCode: code,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      finalizedAt: new Date(),
    });
    return clone(attempt);
  }
  async getByIdempotency(key: string) {
    const id = this.byKey.get(key);
    return id === undefined ? undefined : clone(this.byId.get(id)!);
  }
  private required(id: string) {
    const attempt = this.byId.get(id);
    if (attempt === undefined) throw new Error("unknown attempt");
    return attempt;
  }
}
