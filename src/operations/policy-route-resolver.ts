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

  async resolve(
    taskClass: TaskClass,
    taskId: string,
    fallback: ModelRoute,
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
      return this.nextStaticTier(taskClass, taskId, fallback);

    const attempts = await this.artifacts.forTask(taskId);
    const failures = deriveFailureEvidence(attempts);
    // simulateProgrammingRoute() only checks "is this model available and
    // permitted", not "did this task already try it" -- without excluding
    // already-attempted provider:model pairs, a still-live deepseek model
    // (always permitted, per execution-permission.ts) would be re-selected
    // forever instead of ever escalating past its own verified failure.
    const alreadyAttempted = new Set(
      attempts.map((a) => `${a.providerId}:${a.requestedModelId}`),
    );
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
    if (simulated.selected === null) return fallback;
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
  ): Promise<ModelRoute> {
    const chain = modelRoutes(taskClass);
    if (chain.length === 0) return fallback;

    const attempts = await this.artifacts.forTask(taskId).catch(() => []);
    const tried = new Set(
      attempts.map((a) => `${a.providerId}:${a.requestedModelId}`),
    );
    const next = chain.find(
      (route) => !tried.has(`${route.provider}:${route.requestedModelId}`),
    );
    // Every tier exhausted: stay on the last one. The work engine's own
    // maxAttempts is what stops the task, not this.
    return next ?? chain[chain.length - 1]!;
  }
}
