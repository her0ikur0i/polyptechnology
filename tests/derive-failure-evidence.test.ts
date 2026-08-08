import assert from "node:assert/strict";
import test from "node:test";
import { deriveFailureEvidence } from "../src/policy/derive-failure-evidence.js";

test("accepted artifacts produce no evidence", () => {
  const evidence = deriveFailureEvidence([
    { taskId: "t1", providerId: "deepseek", status: "accepted", reason: null },
  ]);
  assert.deepEqual(evidence, []);
});

test("a rejected deepseek artifact becomes verified failure evidence", () => {
  const evidence = deriveFailureEvidence([
    {
      taskId: "t1",
      providerId: "deepseek",
      status: "rejected",
      reason: "tests_failed",
    },
  ]);
  assert.deepEqual(evidence, [
    {
      taskId: "t1",
      provider: "deepseek",
      outcome: "failed",
      code: "tests_failed",
      verified: true,
    },
  ]);
});

test("a rejected claude artifact produces no evidence (claude has no further fallback)", () => {
  const evidence = deriveFailureEvidence([
    { taskId: "t1", providerId: "claude", status: "rejected", reason: "x" },
  ]);
  assert.deepEqual(evidence, []);
});

test("a missing reason falls back to a generic code, never empty", () => {
  const evidence = deriveFailureEvidence([
    { taskId: "t1", providerId: "codex", status: "rejected", reason: null },
  ]);
  assert.equal(evidence[0]?.code, "verified_patch_rejection");
});

test("multiple tiers for the same task accumulate independently", () => {
  const evidence = deriveFailureEvidence([
    { taskId: "t1", providerId: "deepseek", status: "rejected", reason: "a" },
    { taskId: "t1", providerId: "codex", status: "rejected", reason: "b" },
  ]);
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((e) => e.provider).sort(), [
    "codex",
    "deepseek",
  ]);
});
