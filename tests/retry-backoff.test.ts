import assert from "node:assert/strict";
import test from "node:test";
import {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  retryDelayMs,
} from "../src/operations/execution-supervisor.js";

// The delay between attempts was a hardcoded 1,000 ms, which nobody could see
// while `retry_wait` was terminal in practice. CONTRACT-017 made retries real,
// and the owner watched three tasks spend attempts 1, 2 and 3 inside two
// seconds — reaching `failed`, which is terminal, faster than any outage worth
// retrying through would have cleared.

test("the delay grows with each attempt instead of staying flat", () => {
  assert.equal(retryDelayMs(1), 1_000);
  assert.equal(retryDelayMs(2), 2_000);
  assert.equal(retryDelayMs(3), 4_000);
  assert.equal(retryDelayMs(4), 8_000);
});

test("three attempts now span seconds, not milliseconds", () => {
  const total = retryDelayMs(1) + retryDelayMs(2);
  // The transcript that prompted this: attempt 2 and attempt 3 both landed in
  // the same second. Three attempts must outlast a brief provider blip.
  assert.equal(total, 3_000);
  assert.ok(total > 2_000);
});

test("the delay is capped so a long-lived task does not wait for hours", () => {
  assert.equal(retryDelayMs(40), RETRY_CAP_MS);
  assert.equal(retryDelayMs(100), RETRY_CAP_MS);
  // 2**exponent must never reach Infinity and produce NaN through Math.min.
  assert.ok(Number.isFinite(retryDelayMs(1e6)));
});

test("a nonsense ordinal waits the base interval rather than retrying instantly", () => {
  // Retrying with no delay is the failure being fixed, so it must not be the
  // fallback for bad input either.
  for (const ordinal of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.equal(retryDelayMs(ordinal), RETRY_BASE_MS);
});

test("the delay is always positive", () => {
  for (let attempt = 1; attempt <= 20; attempt += 1)
    assert.ok(retryDelayMs(attempt) > 0);
});
