import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAttempt,
  toFailureEvidence,
} from "../src/policy/failure-classification.js";

test("transport failure retries the same tier, never escalates", () => {
  const decision = classifyAttempt({
    outcome: "failed",
    failureCode: "claude_no_result",
  });
  assert.equal(decision.action, "retry_same_tier");
  assert.equal(toFailureEvidence("t1", "deepseek", decision, "x"), undefined);
});

test("outcome_unknown retries the same tier, never escalates", () => {
  const decision = classifyAttempt({ outcome: "outcome_unknown" });
  assert.equal(decision.action, "retry_same_tier");
});

test("succeeded with no artifact verdict yet does not escalate", () => {
  const decision = classifyAttempt({ outcome: "succeeded" });
  assert.equal(decision.action, "retry_same_tier");
});

test("succeeded and accepted needs no further action", () => {
  const decision = classifyAttempt({
    outcome: "succeeded",
    artifactStatus: "accepted",
  });
  assert.equal(decision.action, "none");
});

test("verified patch rejection is the only path that escalates", () => {
  const decision = classifyAttempt({
    outcome: "succeeded",
    artifactStatus: "rejected",
  });
  assert.equal(decision.action, "escalate");
  const evidence = toFailureEvidence(
    "t1",
    "deepseek",
    decision,
    "tests_failed",
  );
  assert.deepEqual(evidence, {
    taskId: "t1",
    provider: "deepseek",
    outcome: "failed",
    code: "tests_failed",
    verified: true,
  });
});

test("escalation without a reason code produces no evidence", () => {
  const decision = classifyAttempt({
    outcome: "succeeded",
    artifactStatus: "rejected",
  });
  assert.equal(toFailureEvidence("t1", "codex", decision, "  "), undefined);
});
