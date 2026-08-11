import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPolicyRouteResolver } from "../src/operations/policy-route-resolver.js";
import type { RuntimePolicy } from "../src/policy/types.js";
import type { ModelRoute } from "../src/gateway/types.js";
import { modelRoutes } from "../src/gateway/model-policy.js";

const fallback: ModelRoute = {
  provider: "deepseek",
  requestedModelId: "deepseek-v4-flash",
  role: "primary-executor",
};

const runtimePolicy: RuntimePolicy = {
  routesByTaskClass: {
    bulk_code: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        priority: 0,
      },
      { provider: "codex", requestedModelId: "gpt-5.6-sol", priority: 1 },
      { provider: "claude", requestedModelId: "claude-sonnet-5", priority: 2 },
    ],
    complex_backend: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        priority: 0,
      },
    ],
    bounded_repair: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        priority: 0,
      },
    ],
  },
  envelope: {
    softBudgetUsdMicros: 1_000,
    emergencyCostCeilingUsdMicros: 2_000,
    maxOutputTokens: 4_096,
    maxTurns: 5,
    timeoutMs: 30_000,
    concurrency: 2,
  },
};

interface Artifact {
  taskId: string;
  providerId: string;
  requestedModelId: string;
  status: "accepted" | "rejected";
  reason: string | null;
}

function resolver(opts: {
  active?: { policy: unknown };
  artifacts?: ReadonlyArray<Artifact>;
  availability?: ReadonlySet<string>;
}) {
  return new PostgresPolicyRouteResolver(
    {
      async active() {
        return opts.active;
      },
    },
    {
      async forTask() {
        return opts.artifacts ?? [];
      },
    },
    {
      async availableModelKeys() {
        return opts.availability ?? new Set();
      },
    },
    "test-policy",
  );
}

test("non-programming task classes always use the static fallback route", async () => {
  const route = await resolver({ active: { policy: runtimePolicy } }).resolve(
    "orchestration",
    "t1",
    fallback,
  );
  assert.deepEqual(route, fallback);
});

// With no owner policy -- the normal state; staging has never had one -- the
// resolver used to return the caller's fallback on every attempt forever, so
// the static chain's tiers two through five were unreachable and a generation
// task ran deepseek-v4-flash six times. It now walks the chain.
test("no active policy starts at the first tier of the static chain", async () => {
  const route = await resolver({}).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, modelRoutes("bulk_code")[0]);
});

test("no active policy escalates past a tier this task already tried", async () => {
  const route = await resolver({
    artifacts: [
      {
        taskId: "t1",
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        status: "rejected",
        reason: "verification_failed",
      },
    ],
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, modelRoutes("bulk_code")[1]);
});

test("no active policy stays on the last tier once every tier has been tried", async () => {
  const chain = modelRoutes("bulk_code");
  const route = await resolver({
    artifacts: chain.map((tier) => ({
      taskId: "t1",
      providerId: tier.provider,
      requestedModelId: tier.requestedModelId,
      status: "rejected" as const,
      reason: "verification_failed",
    })),
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, chain[chain.length - 1]);
});

test("an active policy with an available first-priority route is used over the static fallback", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set(["deepseek:deepseek-v4-pro"]),
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, {
    provider: "deepseek",
    requestedModelId: "deepseek-v4-pro",
    role: "policy-selected",
  });
});

test("an already-attempted model is excluded so it never gets re-selected", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set(["deepseek:deepseek-v4-pro", "codex:gpt-5.6-sol"]),
    artifacts: [
      {
        taskId: "t1",
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        status: "rejected",
        reason: "tests failed",
      },
    ],
  }).resolve("bulk_code", "t1", fallback);
  // Without exclusion, deepseek would be re-selected forever (it's always
  // permitted, per execution-permission.ts) instead of ever escalating.
  assert.deepEqual(route, {
    provider: "codex",
    requestedModelId: "gpt-5.6-sol",
    role: "policy-selected",
  });
});

test("claude unlocks only once both deepseek and codex have verified-failed", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set([
      "deepseek:deepseek-v4-pro",
      "codex:gpt-5.6-sol",
      "claude:claude-sonnet-5",
    ]),
    artifacts: [
      {
        taskId: "t1",
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        status: "rejected",
        reason: "tests failed",
      },
    ],
  }).resolve("bulk_code", "t1", fallback);
  // Only deepseek verified-failed so far -- codex must be tried next, not
  // claude (execution-permission.ts requires both before claude unlocks).
  assert.deepEqual(route, {
    provider: "codex",
    requestedModelId: "gpt-5.6-sol",
    role: "policy-selected",
  });
});

test("policy engine finding nothing eligible falls back to the static route", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set(), // nothing available at all
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, fallback);
});

test("a policyStore that throws falls back to the static route rather than failing the task", async () => {
  const flaky = new PostgresPolicyRouteResolver(
    {
      async active(): Promise<{ policy: unknown } | undefined> {
        throw new Error("db unavailable");
      },
    },
    {
      async forTask() {
        return [];
      },
    },
    {
      async availableModelKeys() {
        return new Set();
      },
    },
    "test-policy",
  );
  // A policy store that is down must not fail the task; it degrades to the
  // static chain, which is the behaviour that existed before the owner policy
  // engine was added.
  const route = await flaky.resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, modelRoutes("bulk_code")[0]);
});
