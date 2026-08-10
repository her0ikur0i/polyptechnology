import { createHash, randomUUID } from "node:crypto";
import { MODEL_POLICY_VERSION, modelRoutes } from "./model-policy.js";
import type {
  AttemptLedger,
  GatewayAttempt,
  GatewayRequest,
  GatewayResult,
  ManagedProviderAdapter,
  ModelRoute,
} from "./types.js";
import { ManagedInvocationError } from "./types.js";
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item instanceof Set ? [...item].sort() : item,
  );
// Field-by-field, not JSON.stringify string equality: a route that round-
// trips through a jsonb column (operation_task_specs.input.route, used by
// src/operations/ai-patch-operation-driver.ts) comes back with Postgres's
// own jsonb key ordering, not insertion order -- two structurally identical
// routes can stringify to different strings. ModelRoute's shape is small and
// fixed, so comparing every field explicitly is both correct and clearer
// than trying to canonicalize key order before stringifying.
const routeEquals = (a: ModelRoute, b: ModelRoute) =>
  a.provider === b.provider &&
  a.requestedModelId === b.requestedModelId &&
  a.role === b.role &&
  a.mode === b.mode &&
  a.effort === b.effort;
export class GatewayInvocationError extends Error {
  constructor(
    message: string,
    readonly attempt: GatewayAttempt,
  ) {
    super(message);
  }
}
export class AiGateway {
  private readonly adapters = new Map<string, ManagedProviderAdapter>();
  constructor(
    private readonly ledger: AttemptLedger,
    adapters: ReadonlyArray<ManagedProviderAdapter>,
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider))
        throw new Error("duplicate provider adapter");
      this.adapters.set(adapter.provider, adapter);
    }
  }
  async execute(request: GatewayRequest): Promise<GatewayResult> {
    if (request.policyVersion !== MODEL_POLICY_VERSION)
      throw new Error("unknown model policy version");
    this.validate(request);
    const route =
      request.routeOverride ?? (await this.resolve(request.taskClass));
    if (
      request.routeOverride !== undefined &&
      !modelRoutes(request.taskClass).some((candidate) =>
        routeEquals(candidate, request.routeOverride!),
      )
    )
      throw new Error("route override is outside policy");
    const requestHash = createHash("sha256")
      .update(
        stable({
          taskClass: request.taskClass,
          attribution: request.attribution,
          messages: request.messages,
          maxOutputTokens: request.maxOutputTokens,
          maxCostUsdMicros: request.maxCostUsdMicros,
          policyVersion: request.policyVersion,
          route,
        }),
      )
      .digest("hex");
    const initial: GatewayAttempt = {
      id: randomUUID(),
      idempotencyKey: request.idempotencyKey,
      requestHash,
      outcome: "reserved",
      route: { ...route },
      attribution: { ...request.attribution },
      policyVersion: request.policyVersion,
      reservedCostUsdMicros: request.maxCostUsdMicros,
      createdAt: new Date(),
    };
    const reservation = await this.ledger.reserve(initial);
    if (!reservation.created)
      throw new GatewayInvocationError(
        "attempt already exists",
        reservation.attempt,
      );
    const adapter = this.adapters.get(route.provider);
    if (adapter === undefined) {
      const failed = await this.ledger.fail(
        initial.id,
        "provider_unavailable",
        false,
      );
      throw new GatewayInvocationError("provider unavailable", failed);
    }
    await this.ledger.dispatched(initial.id);
    try {
      // Streaming is used only when the caller asked for deltas AND the
      // selected adapter genuinely supports them. Everything downstream of
      // this line -- validation, rejection codes, ledger settlement -- is
      // identical either way, because invokeStreaming() returns the same
      // completion invoke() would have. That is deliberate: a streamed answer
      // must not be able to reach the ledger through a different path than a
      // buffered one, or the two would drift and only one would be tested.
      const streaming =
        request.onDelta !== undefined && adapter.invokeStreaming !== undefined;
      const result = streaming
        ? await adapter.invokeStreaming!(
            route,
            request.messages,
            request.maxOutputTokens,
            request.onDelta!,
            request.signal,
          )
        : await adapter.invoke(
            route,
            request.messages,
            request.maxOutputTokens,
            request.signal,
          );
      let rejection: string | undefined;
      if (result.resolvedModelId !== route.requestedModelId)
        rejection = "resolved_model_mismatch";
      else if (
        result.resolutionSource === "pinned_request" &&
        route.provider !== "codex"
      )
        rejection = "untrusted_model_resolution";
      else if (
        result.providerRequestId.length === 0 ||
        result.content.trim().length === 0 ||
        result.usage.inputTokens < 0 ||
        result.usage.outputTokens < 0 ||
        result.usage.costUsdMicros < 0 ||
        result.usage.costUsdMicros > request.maxCostUsdMicros
      )
        rejection = "invalid_provider_accounting";
      else if (
        result.modelUsage.length === 0 ||
        !result.modelUsage.some(
          (usage) => usage.resolvedModelId === result.resolvedModelId,
        ) ||
        result.modelUsage.reduce(
          (sum, usage) => sum + usage.costUsdMicros,
          0,
        ) !== result.usage.costUsdMicros
      )
        rejection = "invalid_per_model_accounting";
      if (rejection !== undefined) {
        const failed = await this.ledger.reject(initial.id, result, rejection);
        throw new GatewayInvocationError(rejection, failed);
      }
      const outputSha256 = createHash("sha256")
        .update(result.content)
        .digest("hex");
      return {
        attempt: await this.ledger.succeed(initial.id, result, outputSha256),
        content: result.content,
      };
    } catch (error) {
      if (error instanceof GatewayInvocationError) throw error;
      const unknown =
        error instanceof ManagedInvocationError
          ? error.outcomeUnknown || error.providerRequestId !== undefined
          : !(
              error instanceof Error &&
              (error.message.startsWith("resolved model mismatch") ||
                error.message.startsWith("invalid provider") ||
                error.message.startsWith("invalid per-model"))
            );
      const failed = await this.ledger.fail(
        initial.id,
        error instanceof ManagedInvocationError
          ? error.code
          : error instanceof Error
            ? error.message
            : "provider failure",
        unknown,
        ...(error instanceof ManagedInvocationError &&
        error.providerRequestId !== undefined
          ? [error.providerRequestId]
          : []),
      );
      throw new GatewayInvocationError(
        error instanceof Error ? error.message : "provider failure",
        failed,
      );
    }
  }
  // "provider:requestedModelId" keys for every model every registered
  // adapter currently reports -- the format simulateProgrammingRoute()
  // expects for its availability set (src/policy/simulate-route.ts).
  async availableModelKeys(): Promise<ReadonlySet<string>> {
    const keys = new Set<string>();
    for (const [provider, adapter] of this.adapters)
      for (const modelId of await adapter.listModels())
        keys.add(`${provider}:${modelId}`);
    return keys;
  }
  private async resolve(
    taskClass: GatewayRequest["taskClass"],
  ): Promise<ModelRoute> {
    for (const route of modelRoutes(taskClass)) {
      const adapter = this.adapters.get(route.provider);
      if (
        adapter !== undefined &&
        (await adapter.listModels()).includes(route.requestedModelId)
      )
        return route;
    }
    throw new Error("no concrete managed model available");
  }
  private validate(request: GatewayRequest) {
    if (
      request.idempotencyKey.length < 8 ||
      request.messages.length === 0 ||
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      !Number.isSafeInteger(request.maxCostUsdMicros) ||
      request.maxCostUsdMicros < 0 ||
      !Number.isSafeInteger(request.attribution.taskAttemptOrdinal) ||
      request.attribution.taskAttemptOrdinal < 1
    )
      throw new Error("invalid gateway request");
    for (const value of Object.values(request.attribution))
      if (typeof value === "string" && value.length === 0)
        throw new Error("incomplete gateway attribution");
  }
}
