import { technicalExecutionAllowed } from "./execution-permission.js";
import type {
  FailureEvidence,
  OwnerOverride,
  ProgrammingTaskClass,
  RuntimePolicy,
  SimulationResult,
} from "./types.js";
import { validatePolicy } from "./validate-policy.js";

export function simulateProgrammingRoute(
  taskClass: ProgrammingTaskClass,
  taskId: string,
  policy: RuntimePolicy,
  availability: ReadonlySet<string>,
  now: Date,
  failures: readonly FailureEvidence[],
  override?: OwnerOverride,
): SimulationResult {
  const validation = validatePolicy(policy);
  if (validation.length > 0) return { selected: null, reasons: validation };
  const routes = [...policy.routesByTaskClass[taskClass]].sort(
      (a, b) => a.priority - b.priority,
    ),
    reasons: string[] = [];
  for (const route of routes) {
    const key = `${route.provider}:${route.requestedModelId}`;
    if (!availability.has(key)) {
      reasons.push(`${key} unavailable`);
      continue;
    }
    const permission = technicalExecutionAllowed(
      route.provider,
      taskId,
      now,
      failures,
      override,
    );
    if (!permission.allowed) {
      reasons.push(`${key} denied: ${permission.reason}`);
      continue;
    }
    return { selected: route, reasons };
  }
  reasons.push("No eligible programming route");
  return { selected: null, reasons };
}
