import assert from "node:assert/strict";
import test from "node:test";
import { AiGateway, GatewayInvocationError } from "../src/gateway/gateway.js";
import { MemoryAttemptLedger } from "../src/gateway/memory-ledger.js";
import {
  ClaudeCliAdapter,
  CodexCliAdapter,
  parseCodexJsonl,
} from "../src/gateway/cli-adapters.js";
import { providerSummary } from "../src/gateway/summary.js";
import {
  MODEL_POLICY_VERSION,
  modelRoutes,
} from "../src/gateway/model-policy.js";
import type {
  ManagedProviderAdapter,
  ModelRoute,
} from "../src/gateway/types.js";
import { STRANDED_ATTEMPT_CODE } from "../src/gateway/types.js";
const attribution = {
  projectId: "p",
  contractId: "CONTRACT-005",
  milestoneId: "m",
  taskId: "t",
  taskAttemptOrdinal: 1,
  agentId: "gateway",
};
class Fake implements ManagedProviderAdapter {
  readonly provider = "deepseek" as const;
  constructor(private readonly resolved = "deepseek-v4-flash") {}
  async listModels() {
    return ["deepseek-v4-flash", "deepseek-v4-pro"];
  }
  async invoke(_route: ModelRoute) {
    return {
      providerRequestId: "request-1",
      resolvedModelId: this.resolved,
      resolutionSource: "provider_response" as const,
      content: "patch",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 3,
      },
      modelUsage: [
        {
          resolvedModelId: this.resolved,
          inputTokens: 10,
          outputTokens: 2,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 3,
        },
      ],
    };
  }
}
const request = {
  idempotencyKey: "contract005-task-1",
  taskClass: "bulk_code" as const,
  attribution,
  messages: [{ role: "user" as const, content: "bounded work" }],
  maxOutputTokens: 100,
  maxCostUsdMicros: 10,
  policyVersion: MODEL_POLICY_VERSION,
};
test("policy contains concrete models for all providers and task roles", () => {
  const all = (
    [
      "bulk_code",
      "complex_backend",
      "bounded_repair",
      "orchestration",
      "light_review",
      "specialist_review",
      "critical_review",
      "independent_review",
    ] as const
  ).flatMap(modelRoutes);
  assert.ok(all.some((r) => r.requestedModelId === "deepseek-v4-flash"));
  assert.ok(all.some((r) => r.requestedModelId === "gpt-5.6-sol"));
  assert.ok(all.some((r) => r.requestedModelId === "claude-sonnet-5"));
  assert.ok(
    all.every(
      (r) =>
        !new Set(["sonnet", "opus", "codex", "default"]).has(
          r.requestedModelId,
        ),
    ),
  );
});
test("programming routes are DeepSeek-first, escalating deepseek -> codex -> claude", () => {
  const expectations = {
    bulk_code: ["deepseek", "deepseek", "codex", "codex", "claude"],
    complex_backend: ["deepseek", "deepseek", "codex", "codex", "claude"],
    bounded_repair: ["deepseek", "deepseek", "codex", "codex", "claude"],
  } as const;
  const tierRank: Record<string, number> = { deepseek: 0, codex: 1, claude: 2 };
  for (const [taskClass, providers] of Object.entries(expectations)) {
    const actual = modelRoutes(taskClass as keyof typeof expectations);
    assert.deepEqual(
      actual.map((route) => route.provider),
      providers,
    );
    assert.equal(actual[0]?.provider, "deepseek");
    let highestSeen = -1;
    for (const route of actual) {
      const rank = tierRank[route.provider] ?? -1;
      assert.ok(
        rank >= highestSeen,
        `${taskClass}: ${route.provider} must not follow a more expensive tier`,
      );
      highestSeen = Math.max(highestSeen, rank);
    }
  }
});
test("orchestration is Claude-led with a tiered escalation, not Codex", () => {
  assert.deepEqual(
    modelRoutes("orchestration").map((route) => [
      route.provider,
      route.requestedModelId,
    ]),
    [
      ["claude", "claude-sonnet-5"],
      ["claude", "claude-opus-5"],
    ],
  );
});
test("critical_review is not a Claude single point of failure", () => {
  const providers = modelRoutes("critical_review").map(
    (route) => route.provider,
  );
  assert.ok(
    providers.some((provider) => provider !== "claude"),
    "critical_review must have a non-Claude escalation route",
  );
});
test("gateway records resolved model usage and immutable output digest", async () => {
  const ledger = new MemoryAttemptLedger(),
    gateway = new AiGateway(ledger, [new Fake()]);
  const result = await gateway.execute(request);
  assert.equal(result.attempt.outcome, "succeeded");
  assert.equal(result.attempt.resolvedModelId, "deepseek-v4-flash");
  assert.equal(result.attempt.usage?.costUsdMicros, 3);
  assert.match(result.attempt.outputSha256!, /^[a-f0-9]{64}$/);
  assert.equal(
    providerSummary(result.attempt, {
      attemptId: result.attempt.id,
      passed: true,
      verifier: "test-verifier",
      evidenceSha256: "a".repeat(64),
      verifiedAt: new Date(),
    }).resolvedModelId,
    "deepseek-v4-flash",
  );
});
test("route overrides cannot escape the versioned policy", async () => {
  const gateway = new AiGateway(new MemoryAttemptLedger(), [new Fake()]);
  await assert.rejects(
    gateway.execute({
      ...request,
      idempotencyKey: "override-key",
      routeOverride: {
        provider: "deepseek",
        requestedModelId: "unregistered",
        role: "bulk-coder",
      },
    }),
    /outside policy/,
  );
});
test("CLI adapters retain concrete primary and auxiliary model usage", async () => {
  const runner = async () => ({
    stdout: JSON.stringify({
      session_id: "session",
      result: "ok",
      modelUsage: {
        "claude-sonnet-5": { inputTokens: 2, outputTokens: 1, costUSD: 0.001 },
        "claude-haiku-4-5-20251001": {
          inputTokens: 1,
          outputTokens: 1,
          costUSD: 0.0001,
        },
      },
    }),
    stderr: "",
    exitCode: 0,
  });
  const claude = await new ClaudeCliAdapter(runner).invoke(
    {
      provider: "claude",
      requestedModelId: "claude-sonnet-5",
      role: "review",
      effort: "high",
    },
    [{ role: "user", content: "review" }],
    100,
  );
  assert.equal(claude.resolvedModelId, "claude-sonnet-5");
  assert.equal(claude.modelUsage.length, 2);
  const jsonl = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 3, output_tokens: 1, cached_input_tokens: 2 },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  const parsed = parseCodexJsonl(jsonl, "gpt-5.6-sol");
  assert.equal(parsed.resolutionSource, "pinned_request");
  const codex = await new CodexCliAdapter(async () => ({
    stdout: jsonl,
    stderr: "",
    exitCode: 0,
  })).invoke(
    {
      provider: "codex",
      requestedModelId: "gpt-5.6-sol",
      role: "integration",
      effort: "high",
    },
    [{ role: "user", content: "work" }],
    100,
  );
  assert.equal(codex.resolutionSource, "pinned_request");
});
test("idempotency mismatch and unverified model fail closed", async () => {
  const ledger = new MemoryAttemptLedger(),
    gateway = new AiGateway(ledger, [new Fake()]);
  await gateway.execute(request);
  await assert.rejects(
    gateway.execute({
      ...request,
      messages: [{ role: "user", content: "changed" }],
    }),
    /idempotency intent mismatch/,
  );
  const bad = new AiGateway(new MemoryAttemptLedger(), [new Fake("alias")]);
  await assert.rejects(
    bad.execute({ ...request, idempotencyKey: "different-key" }),
    (error) =>
      error instanceof GatewayInvocationError &&
      error.attempt.outcome === "failed",
  );
});

// An attempt whose process died between dispatch and verdict is settled by
// nobody -- which is how twenty Codex attempts came to sit in `dispatched` on
// staging, each holding a reservation and each denying the escalation chain the
// evidence it reads. reclaimStranded() is the ledger's counterpart to the work
// engine's reclaimExpired().
test("a stranded dispatched attempt is settled as unknown, and a live one is not", async () => {
  const ledger = new MemoryAttemptLedger();
  const stranded = {
    id: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "stranded-attempt-1",
    requestHash: "a".repeat(64),
    outcome: "reserved" as const,
    route: modelRoutes("bulk_code")[0]!,
    attribution,
    policyVersion: MODEL_POLICY_VERSION,
    reservedCostUsdMicros: 500_000,
    createdAt: new Date(),
  };
  const live = { ...stranded, id: "22222222-2222-4222-8222-222222222222" };
  live.idempotencyKey = "live-attempt-1";
  await ledger.reserve(stranded);
  await ledger.reserve(live);
  await ledger.dispatched(stranded.id);
  await ledger.dispatched(live.id);
  // Well past the Codex CLI's ten-minute ceiling: no process is still working
  // on this one. The live attempt was dispatched a moment ago.
  ledger.setDispatchedAt(stranded.id, new Date(Date.now() - 3_600_000));

  assert.deepEqual(await ledger.reclaimStranded(1_800_000), [stranded.id]);
  const settled = await ledger.getByIdempotency(stranded.idempotencyKey);
  // Unknown, not failed: a killed process cannot say whether the provider ran
  // or billed, so the reservation stays held for reconciliation with evidence.
  assert.equal(settled?.outcome, "outcome_unknown");
  assert.equal(settled?.failureCode, STRANDED_ATTEMPT_CODE);
  assert.equal(
    (await ledger.getByIdempotency(live.idempotencyKey))?.outcome,
    "dispatched",
  );
  // Reclaiming twice must not re-settle what is already terminal.
  assert.deepEqual(await ledger.reclaimStranded(1_800_000), []);
  // A horizon short enough to catch attempts that are merely slow is refused
  // outright rather than trusted to a caller's arithmetic.
  await assert.rejects(ledger.reclaimStranded(5_000), /horizon/);
});
