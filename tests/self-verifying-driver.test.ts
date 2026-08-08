import assert from "node:assert/strict";
import test from "node:test";
import { isSelfVerifyingResult } from "../src/operations/execution-supervisor.js";

test("a plain deterministic-style output is not self-verifying", () => {
  assert.equal(isSelfVerifyingResult({ sha256: "abc" }), false);
});

test("an object with a boolean verified field is self-verifying", () => {
  assert.equal(isSelfVerifyingResult({ verified: true }), true);
  assert.equal(isSelfVerifyingResult({ verified: false }), true);
});

test("a non-boolean verified field is not self-verifying", () => {
  assert.equal(isSelfVerifyingResult({ verified: "true" }), false);
});

test("null and non-objects are not self-verifying", () => {
  assert.equal(isSelfVerifyingResult(null), false);
  assert.equal(isSelfVerifyingResult("x"), false);
  assert.equal(isSelfVerifyingResult(42), false);
});
