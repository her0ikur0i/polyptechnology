import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimePolicy } from "../src/policy/types.js";
import { validatePolicy } from "../src/policy/validate-policy.js";

const validPolicy: RuntimePolicy = {
  routesByTaskClass: {
    bulk_code: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        priority: 0,
      },
      { provider: "claude", requestedModelId: "claude-sonnet-5", priority: 1 },
    ],
    complex_backend: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        priority: 0,
      },
      { provider: "claude", requestedModelId: "claude-opus-4-8", priority: 1 },
    ],
    bounded_repair: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        priority: 0,
      },
      { provider: "claude", requestedModelId: "claude-sonnet-5", priority: 1 },
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

test("valid policy returns no errors", () => {
  assert.deepEqual(validatePolicy(validPolicy), []);
});

test("bare model alias is rejected", () => {
  const policy = structuredClone(validPolicy);
  policy.routesByTaskClass.bulk_code[0]!.requestedModelId = "sonnet";
  assert.ok(validatePolicy(policy).some((error) => error.includes("concrete")));
});

test("routing order is determined by priority and must start with DeepSeek", () => {
  const policy = structuredClone(validPolicy);
  policy.routesByTaskClass.bulk_code = [
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      priority: 1,
    },
    { provider: "claude", requestedModelId: "claude-sonnet-5", priority: 0 },
  ];
  assert.ok(
    validatePolicy(policy).some((error) => error.includes("first route")),
  );
});

test("DeepSeek after Claude is rejected", () => {
  const policy = structuredClone(validPolicy);
  policy.routesByTaskClass.bulk_code = [
    {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      priority: 0,
    },
    { provider: "claude", requestedModelId: "claude-sonnet-5", priority: 1 },
    { provider: "deepseek", requestedModelId: "deepseek-v4-pro", priority: 2 },
  ];
  assert.ok(
    validatePolicy(policy).some((error) => error.includes("cannot follow")),
  );
});

test("extra task-class key is rejected", () => {
  const policy = structuredClone(validPolicy) as RuntimePolicy & {
    routesByTaskClass: Record<string, unknown>;
  };
  policy.routesByTaskClass.unexpected_key = [];
  assert.ok(
    validatePolicy(policy).some((error) => error.includes("unexpected")),
  );
});

test("soft budget may be zero but emergency ceiling must exceed it", () => {
  const policy = structuredClone(validPolicy);
  policy.envelope.softBudgetUsdMicros = 0;
  policy.envelope.emergencyCostCeilingUsdMicros = 0;
  const errors = validatePolicy(policy);
  assert.equal(
    errors.some((error) => error.startsWith("softBudget")),
    false,
  );
  assert.ok(errors.some((error) => error.startsWith("emergency")));
});
