import type { ProgrammingTaskClass, RuntimePolicy } from "./types.js";

export const PROGRAMMING_TASK_CLASSES = [
  "bulk_code",
  "complex_backend",
  "bounded_repair",
] as const satisfies readonly ProgrammingTaskClass[];

const blockedAliases = new Set(["sonnet", "opus", "codex", "default"]);

export function validatePolicy(policy: RuntimePolicy): string[] {
  const errors: string[] = [],
    envelope = policy.envelope;
  if (
    !Number.isSafeInteger(envelope.softBudgetUsdMicros) ||
    envelope.softBudgetUsdMicros < 0
  )
    errors.push("softBudgetUsdMicros must be a safe integer >= 0");
  if (
    !Number.isSafeInteger(envelope.emergencyCostCeilingUsdMicros) ||
    envelope.emergencyCostCeilingUsdMicros <= envelope.softBudgetUsdMicros
  )
    errors.push(
      "emergencyCostCeilingUsdMicros must exceed softBudgetUsdMicros",
    );
  for (const [key, value] of Object.entries({
    maxOutputTokens: envelope.maxOutputTokens,
    maxTurns: envelope.maxTurns,
    timeoutMs: envelope.timeoutMs,
    concurrency: envelope.concurrency,
  }))
    if (!Number.isSafeInteger(value) || value <= 0)
      errors.push(`${key} must be a safe integer > 0`);

  const actualKeys = Object.keys(policy.routesByTaskClass).sort(),
    expectedKeys = [...PROGRAMMING_TASK_CLASSES].sort(),
    actual = new Set(actualKeys),
    expected = new Set<string>(expectedKeys);
  for (const key of actualKeys)
    if (!expected.has(key)) errors.push(`unexpected route key: ${key}`);
  for (const key of expectedKeys)
    if (!actual.has(key)) errors.push(`missing route key: ${key}`);

  for (const taskClass of PROGRAMMING_TASK_CLASSES) {
    const routes = policy.routesByTaskClass[taskClass];
    if (!Array.isArray(routes) || routes.length === 0) {
      errors.push(`${taskClass} routes must be nonempty`);
      continue;
    }
    const sorted = [...routes].sort((a, b) => a.priority - b.priority),
      priorities = new Set<number>();
    for (const route of sorted) {
      if (!Number.isSafeInteger(route.priority) || route.priority < 0)
        errors.push(`${taskClass}: priority must be safe integer >= 0`);
      else if (priorities.has(route.priority))
        errors.push(`${taskClass}: duplicate priority ${route.priority}`);
      priorities.add(route.priority);
      if (
        route.provider !== "deepseek" &&
        route.provider !== "codex" &&
        route.provider !== "claude"
      )
        errors.push(
          `${taskClass}: provider must be deepseek, codex, or claude`,
        );
      const model = route.requestedModelId.trim();
      if (!model || blockedAliases.has(model.toLowerCase()))
        errors.push(`${taskClass}: concrete requestedModelId required`);
    }
    if (sorted[0]?.provider !== "deepseek")
      errors.push(`${taskClass}: first route must be deepseek`);
    const tierRank: Record<string, number> = {
      deepseek: 0,
      codex: 1,
      claude: 2,
    };
    let highestSeen = -1;
    for (const route of sorted) {
      const rank = tierRank[route.provider] ?? -1;
      if (rank < highestSeen)
        errors.push(
          `${taskClass}: ${route.provider} cannot follow a more expensive tier`,
        );
      highestSeen = Math.max(highestSeen, rank);
    }
  }
  return errors;
}
