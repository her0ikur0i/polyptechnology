import assert from "node:assert/strict";
import test from "node:test";
import { parseStoredAiPatchTaskInput } from "../src/operations/ai-patch-operation-driver.js";

function validRaw() {
  return {
    taskId: "t1",
    taskClass: "bulk_code",
    idempotencyKey: "k1",
    attribution: {
      projectId: "p",
      contractId: "CONTRACT-011",
      milestoneId: "M2",
      taskId: "t1",
      taskAttemptOrdinal: 1,
      agentId: "a",
    },
    messages: [{ role: "user", content: "x" }],
    maxOutputTokens: 100,
    maxCostUsdMicros: 100,
    policyVersion: "2026-08-13.1",
    route: {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-flash",
      role: "primary-executor",
    },
    ownedPaths: ["src/policy/**"],
    workspaceRoot: "/tmp/ws",
    verifyJob: {
      isolationRoot: "/tmp",
      workspaceRoot: "/tmp/ws",
      image: "node@sha256:" + "a".repeat(64),
      command: "npm",
      args: ["test"],
      ownedPaths: ["report.json"],
      capabilities: [],
      timeoutMs: 1000,
      outputByteLimit: 1000,
      memoryMb: 256,
      cpuLimit: 1,
      environment: {},
    },
    fallbackReason: null,
  };
}

test("parses a well-formed stored input", () => {
  const parsed = parseStoredAiPatchTaskInput(validRaw());
  assert.equal(parsed.taskId, "t1");
  assert.deepEqual(parsed.verifyJob.capabilities, []);
});

test("rejects a non-object input", () => {
  assert.throws(() => parseStoredAiPatchTaskInput("nope"));
  assert.throws(() => parseStoredAiPatchTaskInput(null));
});

test("rejects a missing verifyJob", () => {
  const raw = validRaw() as Record<string, unknown>;
  delete raw.verifyJob;
  assert.throws(() => parseStoredAiPatchTaskInput(raw));
});

test("rejects an invalid worker capability", () => {
  const raw = validRaw();
  (raw.verifyJob as { capabilities: unknown }).capabilities = [
    "not-a-real-capability",
  ];
  assert.throws(() => parseStoredAiPatchTaskInput(raw));
});

test("rejects a blank taskId", () => {
  const raw = validRaw();
  raw.taskId = "";
  assert.throws(() => parseStoredAiPatchTaskInput(raw));
});
