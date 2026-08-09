import { PROGRAMMING_TASK_CLASSES } from "../policy/validate-policy.js";
import { simulateProgrammingRoute } from "../policy/simulate-route.js";
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
    if (active === undefined) return fallback;

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
}
