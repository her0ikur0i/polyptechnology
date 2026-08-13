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
  mode: "non-thinking",
};

const runtimePolicy: RuntimePolicy = {
  routesByTaskClass: {
    bulk_code: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        priority: 0,
      },
      { provider: "codex", requestedModelId: "gpt-5.5", priority: 1 },
      {
        provider: "claude",
        requestedModelId: "claude-sonnet-4-6",
        priority: 2,
      },
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
// task ran the first DeepSeek tier six times. It now walks the chain.
test("no active policy starts at the first tier of the static chain", async () => {
  const route = await resolver({}).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, modelRoutes("bulk_code")[0]);
});

test("no active policy escalates past a tier this task already tried", async () => {
  const firstTier = modelRoutes("bulk_code")[0]!;
  const route = await resolver({
    artifacts: [
      {
        taskId: "t1",
        providerId: firstTier.provider,
        requestedModelId: firstTier.requestedModelId,
        status: "rejected",
        reason: "verification_failed",
      },
    ],
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, modelRoutes("bulk_code")[0]);
});

test("no active policy stays on the last tier once every tier has been tried", async () => {
  const chain = modelRoutes("bulk_code");
  const route = await resolver({
    artifacts: settled(chain.length),
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, chain[chain.length - 1]);
});

test("an active policy with an available first-priority route is used over the static fallback", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set(["deepseek:deepseek-v4-pro"]),
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, modelRoutes("bulk_code")[0]);
});

test("an already-attempted model is excluded so it never gets re-selected", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set(["deepseek:deepseek-v4-pro", "codex:gpt-5.5"]),
    artifacts: [
      {
        taskId: "t1",
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        status: "rejected",
        reason: "tests failed",
      },
      {
        taskId: "t1",
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        status: "rejected",
        reason: "repair retry still failed",
      },
    ],
  }).resolve("bulk_code", "t1", fallback);
  // Without exclusion, deepseek would be re-selected forever (it's always
  // permitted, per execution-permission.ts) instead of ever escalating.
  assert.deepEqual(route, modelRoutes("bulk_code")[2]);
});

test("claude unlocks only once both deepseek and codex have verified-failed", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set([
      "deepseek:deepseek-v4-pro",
      "codex:gpt-5.5",
      "claude:claude-sonnet-4-6",
    ]),
    artifacts: [
      {
        taskId: "t1",
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        status: "rejected",
        reason: "tests failed",
      },
      {
        taskId: "t1",
        providerId: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        status: "rejected",
        reason: "repair retry still failed",
      },
    ],
  }).resolve("bulk_code", "t1", fallback);
  // Only deepseek verified-failed so far -- codex must be tried next, not
  // claude (execution-permission.ts requires both before claude unlocks).
  assert.deepEqual(route, modelRoutes("bulk_code")[2]);
});

test("active policy routes keep the gateway allowlist route shape", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set(["deepseek:deepseek-v4-pro"]),
  }).resolve("bulk_code", "t1", fallback);
  assert.equal(route.role, "primary-executor");
  assert.equal(route.mode, "non-thinking");
});

test("policy engine finding nothing eligible falls back to the static route", async () => {
  const route = await resolver({
    active: { policy: runtimePolicy },
    availability: new Set(), // nothing available at all
  }).resolve("bulk_code", "t1", fallback);
  assert.deepEqual(route, modelRoutes("bulk_code")[0]);
});

test("static fallback skips unavailable tiers instead of burning attempts on them", async () => {
  const chain = modelRoutes("bulk_code");
  const route = await resolver({
    availability: new Set([
      "deepseek:deepseek-v4-pro",
      "deepseek:deepseek-v4-flash",
      "codex:gpt-5.5",
    ]),
    artifacts: settled(3),
  }).resolve("bulk_code", "t1", fallback, 6);
  assert.deepEqual(route, chain[2]);
});

test("a DeepSeek verifier rejection gets one same-model repair retry before the next model", async () => {
  const chain = modelRoutes("bulk_code");
  const firstRepair = await resolver({
    artifacts: [
      {
        taskId: "t1",
        providerId: chain[0]!.provider,
        requestedModelId: chain[0]!.requestedModelId,
        status: "rejected" as const,
        reason: "patch_apply_failed: trailing whitespace; patch does not apply",
      },
    ],
  }).resolve("bulk_code", "t1", fallback, 2);
  assert.deepEqual(firstRepair, chain[0]);

  const escalated = await resolver({
    artifacts: [
      {
        taskId: "t1",
        providerId: chain[0]!.provider,
        requestedModelId: chain[0]!.requestedModelId,
        status: "rejected" as const,
        reason: "patch_apply_failed: trailing whitespace; patch does not apply",
      },
      {
        taskId: "t1",
        providerId: chain[0]!.provider,
        requestedModelId: chain[0]!.requestedModelId,
        status: "rejected" as const,
        reason: "patch_apply_failed: patch does not apply",
      },
    ],
  }).resolve("bulk_code", "t1", fallback, 3);
  assert.deepEqual(escalated, chain[1]);
});

test("a DeepSeek no-diff rejection is repairable before the next model", async () => {
  const chain = modelRoutes("bulk_code");
  const route = await resolver({
    artifacts: [
      {
        taskId: "t1",
        providerId: chain[0]!.provider,
        requestedModelId: chain[0]!.requestedModelId,
        status: "rejected" as const,
        reason: "patch has no diff --git headers",
      },
    ],
  }).resolve("bulk_code", "t1", fallback, 2);
  assert.deepEqual(route, chain[0]);
});

test("a DeepSeek test failure is repairable before the next model", async () => {
  const chain = modelRoutes("bulk_code");
  const route = await resolver({
    artifacts: [
      {
        taskId: "t1",
        providerId: chain[0]!.provider,
        requestedModelId: chain[0]!.requestedModelId,
        status: "rejected" as const,
        reason: "verification_failed: Subtest: format has two decimal places",
      },
    ],
  }).resolve("bulk_code", "t1", fallback, 2);
  assert.deepEqual(route, chain[0]);
});

test("DeepSeek escalates after the repair retry also fails", async () => {
  const chain = modelRoutes("bulk_code");
  const route = await resolver({
    artifacts: [
      {
        taskId: "t1",
        providerId: chain[0]!.provider,
        requestedModelId: chain[0]!.requestedModelId,
        status: "rejected" as const,
        reason: "verification_failed: Subtest: format has two decimal places",
      },
      {
        taskId: "t1",
        providerId: chain[0]!.provider,
        requestedModelId: chain[0]!.requestedModelId,
        status: "rejected" as const,
        reason: "verification_failed: retry still failed",
      },
    ],
  }).resolve("bulk_code", "t1", fallback, 3);
  assert.deepEqual(route, chain[1]);
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

// A tier that fails WITHOUT recording a verdict must not be retried forever.
//
// `provider_artifacts` only records tiers that reached a judgement. A tier
// whose CLI timed out or returned unparseable telemetry leaves no row, so it
// stayed "untried" and was selected again on every remaining attempt.
//
// Observed on the first genuinely hard brief: early tiers recorded rejections,
// then the Codex fallback failed three times running with invalid telemetry and
// consumed every remaining attempt. The final Claude tier, the one most likely
// to succeed on hard work, was never reached at all.
const settled = (count: number) =>
  modelRoutes("bulk_code")
    .slice(0, count)
    .flatMap((tier) => {
      const verdict = {
        taskId: "t1",
        providerId: tier.provider,
        requestedModelId: tier.requestedModelId,
        status: "rejected" as const,
        reason: "verification_failed",
      };
      return tier.provider === "deepseek"
        ? [verdict, { ...verdict, reason: "repair retry still failed" }]
        : [verdict];
    });

test("a tier that recorded no verdict is retried exactly once", async () => {
  const chain = modelRoutes("bulk_code");
  const penultimate = chain.length - 2;
  const final = chain.length - 1;
  const artifacts = settled(penultimate);
  // All tiers before the penultimate tier judged and rejected; the next attempt
  // is the first at the penultimate tier.
  const first = await resolver({ artifacts }).resolve(
    "bulk_code",
    "t1",
    fallback,
    artifacts.length + 1,
  );
  assert.deepEqual(first, chain[penultimate]);

  // Next attempt: the penultimate tier produced no artifact, so it gets its one
  // retry -- a timeout says nothing about whether that model could do the work.
  const retry = await resolver({ artifacts }).resolve(
    "bulk_code",
    "t1",
    fallback,
    artifacts.length + 2,
  );
  assert.deepEqual(retry, chain[penultimate]);

  // Still no verdict after two tries, so the chain moves on and the final tier
  // finally gets asked.
  const escalated = await resolver({ artifacts }).resolve(
    "bulk_code",
    "t1",
    fallback,
    artifacts.length + 3,
  );
  assert.deepEqual(escalated, chain[final]);
});

test("verdicts still drive escalation ahead of the retry allowance", async () => {
  const chain = modelRoutes("bulk_code");
  // Every attempt so far reached a verdict, so there is nothing to retry and
  // each attempt simply takes the next tier.
  for (let judged = 0; judged < chain.length; judged++) {
    const route = await resolver({ artifacts: settled(judged) }).resolve(
      "bulk_code",
      "t1",
      fallback,
      judged + 1,
    );
    assert.deepEqual(route, chain[judged], `after ${judged} verdicts`);
  }
});
