import type { ManagedCompletion, ModelRoute } from "./types.js";

// How a provider actually charges this owner.
//
// The distinction is not cosmetic, and the ledger was wrong about it for every
// call it ever recorded. Checked against the providers' own dashboards on
// 2026-08-11:
//
//   provider   calls  tokens    ledger said   actually billed
//   claude        62  41,650    $2.4233       $0  -- subscription
//   deepseek      24  50,841    $0.0282       $0.03 (29 req, 56,586 tok)
//   codex          9 132,777    $0.0000       $0  -- subscription
//
// DeepSeek is metered: a real API key, billed per token, and the ledger tracks
// it almost exactly. Claude and Codex are reached through their CLIs on
// subscription plans -- `CLAUDE_CODE_OAUTH_TOKEN` and a ChatGPT login -- where
// no per-token charge exists at all.
//
// The Claude CLI nonetheless reports a `costUSD` per call: what the same tokens
// *would* cost on metered API pricing. The gateway recorded that as spend, so
// **97% of this system's reported spend was money nobody was ever charged**,
// and the owner's Telegram reports showed budget bars, percentages and
// "$0.9148 left of $1.00" computed from it. Codex reports zero and was right.
//
// A budget that counts imaginary dollars is worse than no budget: it exhausts
// scopes, blocks real work, and reports confidently while doing it.
export type BillingModel = "metered" | "subscription";

const BILLING: Record<string, BillingModel> = {
  deepseek: "metered",
  claude: "subscription",
  codex: "subscription",
};

export function billingModelFor(provider: string): BillingModel {
  // Unknown providers are treated as metered: assuming a new provider bills
  // per token is the conservative error, because it makes the budget stricter
  // rather than blind.
  return BILLING[provider] ?? "metered";
}

// Strips notional cost from a completion produced by a subscription provider,
// keeping every token count intact.
//
// Tokens are still the real signal for these providers -- they are what the
// plan's usage limits are spent against -- so nothing is discarded except the
// dollar figure that was never charged. Metered completions pass through
// untouched.
export function withTruthfulCost(
  route: ModelRoute,
  completion: ManagedCompletion,
): ManagedCompletion {
  if (billingModelFor(route.provider) === "metered") return completion;
  return {
    ...completion,
    usage: { ...completion.usage, costUsdMicros: 0 },
    modelUsage: completion.modelUsage.map((usage) => ({
      ...usage,
      costUsdMicros: 0,
    })),
  };
}
