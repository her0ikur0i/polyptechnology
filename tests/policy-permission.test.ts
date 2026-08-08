import assert from "node:assert/strict";
import test from "node:test";
import { technicalExecutionAllowed } from "../src/policy/execution-permission.js";
import type { FailureEvidence, OwnerOverride } from "../src/policy/types.js";

const now = new Date("2026-08-08T00:00:00Z");

test("DeepSeek technical execution is unconditional", () => {
  assert.equal(
    technicalExecutionAllowed("deepseek", "task-1", now, []).allowed,
    true,
  );
});

test("Claude is denied without failure evidence", () => {
  assert.equal(
    technicalExecutionAllowed("claude", "task-1", now, []).allowed,
    false,
  );
});

test("Claude is denied by DeepSeek failure alone (Codex must fail too)", () => {
  const deepseekFailure: FailureEvidence = {
    taskId: "task-1",
    provider: "deepseek",
    outcome: "failed",
    code: "verified_failure",
    verified: true,
  };
  assert.equal(
    technicalExecutionAllowed("claude", "task-1", now, [deepseekFailure])
      .allowed,
    false,
  );
});

test("Claude is allowed by matching verified DeepSeek and Codex failures", () => {
  const failures: FailureEvidence[] = [
    {
      taskId: "task-1",
      provider: "deepseek",
      outcome: "failed",
      code: "verified_failure",
      verified: true,
    },
    {
      taskId: "task-1",
      provider: "codex",
      outcome: "failed",
      code: "verified_failure",
      verified: true,
    },
  ];
  assert.equal(
    technicalExecutionAllowed("claude", "task-1", now, failures).allowed,
    true,
  );
});

test("Claude is denied by different-task failure", () => {
  const failure: FailureEvidence = {
    taskId: "task-2",
    provider: "deepseek",
    outcome: "failed",
    code: "verified_failure",
    verified: true,
  };
  assert.equal(
    technicalExecutionAllowed("claude", "task-1", now, [failure]).allowed,
    false,
  );
});

test("Codex is denied without owner override", () => {
  assert.equal(
    technicalExecutionAllowed("codex", "task-1", now, []).allowed,
    false,
  );
});

test("Codex is denied by wrong-task and expired override", () => {
  const override: OwnerOverride = {
    taskId: "task-2",
    ownerId: "owner-1",
    reason: "bounded override",
    expiresAt: new Date("2025-01-01T00:00:00Z"),
    codexTechnicalExecution: true,
  };
  assert.equal(
    technicalExecutionAllowed("codex", "task-1", now, [], override).allowed,
    false,
  );
});

test("Codex is allowed by exact unexpired owner override", () => {
  const override: OwnerOverride = {
    taskId: "task-1",
    ownerId: "owner-1",
    reason: "bounded override",
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    codexTechnicalExecution: true,
  };
  assert.equal(
    technicalExecutionAllowed("codex", "task-1", now, [], override).allowed,
    true,
  );
});
