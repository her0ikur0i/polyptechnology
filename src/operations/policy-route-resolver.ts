import { PROGRAMMING_TASK_CLASSES } from "../policy/validate-policy.js";
import { simulateProgrammingRoute } from "../policy/simulate-route.js";
import { modelRoutes } from "../gateway/model-policy.js";
import { deriveFailureEvidence } from "../policy/derive-failure-evidence.js";
import type { ProgrammingTaskClass, RuntimePolicy } from "../policy/types.js";
import type { ModelRoute, TaskClass } from "../gateway/types.js";

export interface PolicyStoreLike {
  active(policyKey: string): Promise<{ policy: unknown } | undefined>;
}
export interface ProviderArtifactReaderLike {
  forTask(taskId: string): Promise<
    ReadonlyArray<{
      taskId: string;
      providerId: string;
      requestedModelId: string;
      status: "accepted" | "rejected";
      reason: string | null;
    }>
  >;
}
export interface GatewayAvailabilityLike {
  availableModelKeys(): Promise<ReadonlySet<string>>;
}

function artifactKey(artifact: {
  providerId: string;
  requestedModelId: string;
}): string {
  return `${artifact.providerId}:${artifact.requestedModelId}`;
}

function routeKey(route: ModelRoute): string {
  return `${route.provider}:${route.requestedModelId}`;
}

function isDeepSeekRepairRetryEligible(
  artifact: {
    providerId: string;
    reason: string | null;
    status: "accepted" | "rejected";
  },
  verdictCount: number,
): boolean {
  if (verdictCount !== 1) return false;
  if (artifact.providerId !== "deepseek" || artifact.status !== "rejected")
    return false;
  return (artifact.reason ?? "").trim().length > 0;
}

function isProgrammingTaskClass(
  taskClass: TaskClass,
): taskClass is ProgrammingTaskClass {
  return (PROGRAMMING_TASK_CLASSES as readonly string[]).includes(taskClass);
}

// AiGateway.resolve() only ever reads the static src/gateway/model-policy.ts
// table -- it has no idea the owner-adjustable RuntimePolicy engine
// (src/policy/**, wired to HTTP in CONTRACT-012) even exists. This is the
// bridge: for the three programming task classes the policy engine actually
// covers, resolve the route from whatever policy is currently *active* for
// policyKey, using the same verified-failure-evidence chain execution
// already enforces (src/policy/execution-permission.ts via
// simulateProgrammingRoute). A caller-supplied fallback route (the static
// default chosen at task-creation time) is used whenever no active policy
// exists, the policy has nothing eligible, or the task class isn't one the
// policy engine covers (e.g. orchestration, *_review) -- the static table
// remains the safety net, the owner policy is an optional override layer
// that takes precedence only when genuinely active.
export class PostgresPolicyRouteResolver {
  constructor(
    private readonly policyStore: PolicyStoreLike,
    private readonly artifacts: ProviderArtifactReaderLike,
    private readonly gateway: GatewayAvailabilityLike,
    private readonly policyKey: string,
  ) {}

  async failureEvidence(taskId: string): Promise<ReadonlyArray<string>> {
    const artifacts = await this.artifacts.forTask(taskId).catch(() => []);
    return artifacts
      .filter((artifact) => artifact.status === "rejected" && artifact.reason)
      .slice(-2)
      .map((artifact) => artifact.reason!.slice(0, 2_000));
  }

  async resolve(
    taskClass: TaskClass,
    taskId: string,
    fallback: ModelRoute,
    attemptOrdinal = 1,
  ): Promise<ModelRoute> {
    if (!isProgrammingTaskClass(taskClass)) return fallback;

    const active = await this.policyStore
      .active(this.policyKey)
      .catch(() => undefined);
    // No active owner policy is the normal state -- staging has never had a
    // row in `orchestration_policies`. It used to mean "return the caller's
    // fallback", which is the *first* entry of the static table, on every
    // attempt forever. So the static escalation chain
    // deepseek-flash -> deepseek-pro -> codex -> codex -> claude existed in
    // `model-policy.ts`, was quoted in comments and contracts as the system's
    // central routing principle, and **tiers two through five were
    // unreachable**. Six real attempts on a generation task all ran
    // deepseek-v4-flash.
    //
    // The static table is a chain, so walk it: skip what this task has already
    // tried, and take the next tier. The owner policy still overrides
    // completely when one is active; this is what happens in its absence.
    if (active === undefined)
      return this.nextStaticTier(taskClass, taskId, fallback, attemptOrdinal);

    const attempts = await this.artifacts.forTask(taskId);
    const failures = deriveFailureEvidence(attempts);
    // simulateProgrammingRoute() only checks "is this model available and
    // permitted", not "did this task already try it" -- without excluding
    // already-attempted provider:model pairs, a still-live deepseek model
    // (always permitted, per execution-permission.ts) would be re-selected
    // forever instead of ever escalating past its own verified failure.
    const verdictCounts = new Map<string, number>();
    for (const attempt of attempts)
      verdictCounts.set(
        artifactKey(attempt),
        (verdictCounts.get(artifactKey(attempt)) ?? 0) + 1,
      );
    const alreadyAttempted = new Set<string>();
    for (const attempt of attempts) {
      const key = artifactKey(attempt);
      if (!isDeepSeekRepairRetryEligible(attempt, verdictCounts.get(key) ?? 0))
        alreadyAttempted.add(key);
    }
    const availability = new Set(
      [...(await this.gateway.availableModelKeys())].filter(
        (key) => !alreadyAttempted.has(key),
      ),
    );
    const simulated = simulateProgrammingRoute(
      taskClass,
      taskId,
      active.policy as RuntimePolicy,
      availability,
      new Date(),
      failures,
    );
    if (simulated.selected === null)
      return this.nextStaticTier(taskClass, taskId, fallback, attemptOrdinal);
    return {
      provider: simulated.selected.provider,
      requestedModelId: simulated.selected.requestedModelId,
      role: "policy-selected",
    };
  }

  // The next untried tier of the static chain, or the last one once every tier
  // has been tried.
  //
  // "Tried" is read from `provider_artifacts`, the same durable evidence the
  // policy path uses -- not from an attempt counter -- so a tier that failed
  // for a transport reason and recorded nothing is retried on its own tier
  // rather than being skipped. That matches the standing rule that a transport
  // failure retries the same tier and never escalates.
  private async nextStaticTier(
    taskClass: TaskClass,
    taskId: string,
    fallback: ModelRoute,
    attemptOrdinal: number,
  ): Promise<ModelRoute> {
    const chain = modelRoutes(taskClass);
    if (chain.length === 0) return fallback;

    const attempts = await this.artifacts.forTask(taskId).catch(() => []);
    const available = await this.gateway
      .availableModelKeys()
      .catch(() => new Set<string>());
    const hasAvailability = available.size > 0;
    const verdictCounts = new Map<string, number>();
    for (const attempt of attempts)
      verdictCounts.set(
        artifactKey(attempt),
        (verdictCounts.get(artifactKey(attempt)) ?? 0) + 1,
      );
    const settled = new Set<string>();
    for (const attempt of attempts) {
      const key = artifactKey(attempt);
      if (!isDeepSeekRepairRetryEligible(attempt, verdictCounts.get(key) ?? 0))
        settled.add(key);
    }
    const isAvailable = (route: ModelRoute) =>
      !hasAvailability || available.has(routeKey(route));
    const remaining = chain.filter(
      (route) => !settled.has(routeKey(route)) && isAvailable(route),
    );
    const availableChain = chain.filter(isAvailable);
    if (remaining.length === 0 && availableChain.length === 0) return fallback;
    // Every tier has reached a verdict: stay on the last one. The work
    // engine's maxAttempts is what stops the task, not this.
    if (remaining.length === 0)
      return availableChain[availableChain.length - 1]!;

    // A tier that failed without reaching a verdict gets one retry, then the
    // chain moves on.
    //
    // `provider_artifacts` only records tiers that produced a *judgement* --
    // accepted or rejected. A tier that never got that far, because the CLI
    // timed out or returned unparseable telemetry, leaves no row, so it stayed
    // "untried" and was selected again on every remaining attempt.
    //
    // Observed on the first genuinely hard brief: the early tiers recorded
    // rejections, then the Codex fallback failed three times running with
    // invalid telemetry and consumed every remaining attempt. The final Claude
    // tier, the one most likely to succeed on hard work, was never reached --
    // the task exhausted maxAttempts without ever asking it.
    //
    // Retrying the same tier once keeps the intent of the standing rule -- a
    // transport failure retries its own tier, because a timeout says nothing
    // about whether that model could do the work -- while removing the dead
    // end. The rule as originally written said "retries the same tier" with no
    // limit, and that is what let one stalled tier consume every attempt.
    // CLAUDE.md's invariant was amended to say "once" rather than left to
    // disagree with this code.
    const unsettled = Math.max(0, attemptOrdinal - 1 - attempts.length);
    const skip = Math.floor(unsettled / 2);
    return remaining[Math.min(skip, remaining.length - 1)]!;
  }
}
