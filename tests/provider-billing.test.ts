import assert from "node:assert/strict";
import test from "node:test";
import {
  billingModelFor,
  withTruthfulCost,
} from "../src/gateway/provider-billing.js";
import type { ManagedCompletion, ModelRoute } from "../src/gateway/types.js";

// Checked against the providers' own dashboards on 2026-08-11:
//
//   claude     62 calls, 41,650 tok   ledger $2.4233   actually $0 (subscription)
//   deepseek   24 calls, 50,841 tok   ledger $0.0282   actually $0.03
//   codex       9 calls, 132,777 tok  ledger $0.0000   actually $0 (subscription)
//
// The Claude CLI reports what its tokens *would* cost on metered pricing, and
// the gateway recorded that as spend -- so 97% of this system's reported spend
// was money nobody was charged, and it exhausted real budget scopes.

function completion(costUsdMicros: number): ManagedCompletion {
  return {
    providerRequestId: "req-1",
    resolvedModelId: "m",
    resolutionSource: "provider_response",
    content: "x",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costUsdMicros,
    },
    modelUsage: [
      {
        resolvedModelId: "m",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        costUsdMicros,
      },
    ],
  };
}

const route = (provider: string): ModelRoute =>
  ({ provider, requestedModelId: "m", role: "r" }) as ModelRoute;

test("the two CLI providers are subscription, DeepSeek is metered", () => {
  assert.equal(billingModelFor("claude"), "subscription");
  assert.equal(billingModelFor("codex"), "subscription");
  assert.equal(billingModelFor("deepseek"), "metered");
});

// Assuming a new provider bills per token makes the budget stricter rather
// than blind, which is the safe direction to be wrong in.
test("an unknown provider is assumed metered", () => {
  assert.equal(billingModelFor("something-new"), "metered");
});

test("a metered completion keeps its cost exactly", () => {
  const original = completion(85_200);
  const settled = withTruthfulCost(route("deepseek"), original);
  assert.equal(settled.usage.costUsdMicros, 85_200);
  assert.equal(settled.modelUsage[0]?.costUsdMicros, 85_200);
});

test("a subscription completion's notional cost is dropped", () => {
  const settled = withTruthfulCost(route("claude"), completion(85_200));
  assert.equal(settled.usage.costUsdMicros, 0);
  assert.equal(settled.modelUsage[0]?.costUsdMicros, 0);
});

// Tokens are the real signal for a subscription plan -- they are what its
// usage limits are spent against -- so nothing but the dollar figure goes.
test("a subscription completion keeps every token count", () => {
  const settled = withTruthfulCost(route("claude"), completion(85_200));
  assert.equal(settled.usage.inputTokens, 100);
  assert.equal(settled.usage.outputTokens, 50);
  assert.equal(settled.usage.reasoningTokens, 10);
  assert.equal(settled.usage.cacheReadTokens, 5);
  assert.equal(settled.modelUsage[0]?.inputTokens, 100);
  assert.equal(settled.modelUsage[0]?.outputTokens, 50);
});

test("content and identity are untouched", () => {
  const settled = withTruthfulCost(route("codex"), completion(1_000));
  assert.equal(settled.content, "x");
  assert.equal(settled.providerRequestId, "req-1");
  assert.equal(settled.resolvedModelId, "m");
});
