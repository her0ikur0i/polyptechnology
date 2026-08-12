import type {
  AttemptLedger,
  GatewayAttempt,
  ManagedCompletion,
} from "./types.js";
import { STRANDED_ATTEMPT_CODE } from "./types.js";
const clone = (attempt: GatewayAttempt): GatewayAttempt =>
  structuredClone(attempt);
// The in-memory ledger the tests drive. It must agree with
// PostgresAttemptLedger about what is and is not unique, or a test can pass
// against a rule the real database does not enforce -- or fail against one it
// no longer has.
//
// It used to reject a repeated `providerRequestId`. Migration 0017 dropped
// exactly that constraint from both `ai_usage_events` and
// `ai_gateway_attempts`, because CONTRACT-017A established that
// `provider_request_id` is a *session* id: one value legitimately covers every
// turn of a resumed conversation, and every attempt of a retried task that
// stays on the same session. Per-call identity is the attempt id.
//
// Keeping the check here would have made this ledger stricter than production
// and would fail perfectly valid retries.
export class MemoryAttemptLedger implements AttemptLedger {
  private readonly byId = new Map<string, GatewayAttempt>();
  private readonly byKey = new Map<string, string>();
  private readonly dispatchedAt = new Map<string, Date>();
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
    this.dispatchedAt.set(attemptId, new Date());
  }
  async succeed(
    attemptId: string,
    result: ManagedCompletion,
    outputSha256: string,
  ) {
    const attempt = this.required(attemptId);
    if (attempt.outcome !== "dispatched")
      throw new Error("attempt cannot succeed");
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
  // Mirrors PostgresAttemptLedger.reclaimStranded(), including the refusal of
  // a horizon short enough to reclaim attempts that are merely slow.
  //
  // `dispatchedAt` is tracked only for this: the real table has a
  // `dispatched_at` column and this ledger did not, so without it a test here
  // would have had to measure staleness from `createdAt` and would have been
  // asserting a rule the database does not implement.
  async reclaimStranded(olderThanMs: number): Promise<ReadonlyArray<string>> {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 60_000)
      throw new Error("invalid stranded attempt horizon");
    const cutoff = Date.now() - olderThanMs,
      reclaimed: string[] = [];
    for (const attempt of this.byId.values()) {
      const dispatchedAt = this.dispatchedAt.get(attempt.id);
      if (
        attempt.outcome !== "dispatched" ||
        dispatchedAt === undefined ||
        dispatchedAt.getTime() > cutoff
      )
        continue;
      Object.assign(attempt, {
        outcome: "outcome_unknown" as const,
        failureCode: STRANDED_ATTEMPT_CODE,
        finalizedAt: new Date(),
      });
      reclaimed.push(attempt.id);
    }
    return reclaimed;
  }
  // Test seam, with no counterpart in the Postgres ledger because the database
  // has a clock: it lets a test place an attempt's dispatch in the past instead
  // of sleeping through the horizon.
  setDispatchedAt(attemptId: string, at: Date) {
    this.required(attemptId);
    this.dispatchedAt.set(attemptId, at);
  }
  private required(id: string) {
    const attempt = this.byId.get(id);
    if (attempt === undefined) throw new Error("unknown attempt");
    return attempt;
  }
}
