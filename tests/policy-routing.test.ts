import assert from "node:assert/strict";
import test from "node:test";
import { simulateProgrammingRoute } from "../src/policy/simulate-route.js";
import type { FailureEvidence, RuntimePolicy } from "../src/policy/types.js";

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

const now = new Date("2026-08-08T00:00:00Z"),
  failure: FailureEvidence = {
    taskId: "task-1",
    provider: "deepseek",
    outcome: "failed",
    code: "verified_failure",
    verified: true,
  },
  codexFailure: FailureEvidence = {
    taskId: "task-1",
    provider: "codex",
    outcome: "failed",
    code: "verified_failure",
    verified: true,
  };

test("simulator selects DeepSeek first", () => {
  const result = simulateProgrammingRoute(
    "bulk_code",
    "task-1",
    validPolicy,
    new Set(["deepseek:deepseek-v4-flash", "claude:claude-sonnet-5"]),
    now,
    [],
  );
  assert.equal(result.selected?.provider, "deepseek");
  assert.deepEqual(result.reasons, []);
});

test("simulator denies Claude without matching failure", () => {
  const result = simulateProgrammingRoute(
    "bulk_code",
    "task-1",
    validPolicy,
    new Set(["claude:claude-sonnet-5"]),
    now,
    [],
  );
  assert.equal(result.selected, null);
  assert.ok(
    result.reasons.some(
      (reason) => reason.includes("claude") && reason.includes("denied"),
    ),
  );
});

test("simulator denies Claude after only DeepSeek has verified-failed (Codex must fail too)", () => {
  const result = simulateProgrammingRoute(
    "bulk_code",
    "task-1",
    validPolicy,
    new Set(["claude:claude-sonnet-5"]),
    now,
    [failure],
  );
  assert.equal(result.selected, null);
});

test("simulator selects Claude after verified same-task DeepSeek and Codex failures", () => {
  const result = simulateProgrammingRoute(
    "bulk_code",
    "task-1",
    validPolicy,
    new Set(["claude:claude-sonnet-5"]),
    now,
    [failure, codexFailure],
  );
  assert.equal(result.selected?.provider, "claude");
});

test("different-task failure cannot unlock Claude", () => {
  const result = simulateProgrammingRoute(
    "bulk_code",
    "task-1",
    validPolicy,
    new Set(["claude:claude-sonnet-5"]),
    now,
    [{ ...failure, taskId: "task-other" }],
  );
  assert.equal(result.selected, null);
});

test("simulator selects the requested task class rather than bulk-code routes", () => {
  const policy: RuntimePolicy = structuredClone(validPolicy);
  const result = simulateProgrammingRoute(
    "complex_backend",
    "task-1",
    policy,
    new Set(["deepseek:deepseek-v4-pro", "claude:claude-opus-4-8"]),
    now,
    [],
  );
  assert.equal(result.selected?.requestedModelId, "deepseek-v4-pro");
});
