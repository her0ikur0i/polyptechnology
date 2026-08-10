import assert from "node:assert/strict";
import test from "node:test";
import { AiGateway } from "../src/gateway/gateway.js";
import { MemoryAttemptLedger } from "../src/gateway/memory-ledger.js";
import { ClaudeCliAdapter } from "../src/gateway/cli-adapters.js";
import type { CliStreamRunner } from "../src/gateway/cli-adapters.js";
import {
  MODEL_POLICY_VERSION,
  modelRoutes,
} from "../src/gateway/model-policy.js";
import type {
  ManagedProviderAdapter,
  ModelRoute,
} from "../src/gateway/types.js";

const route: ModelRoute = {
  provider: "claude",
  requestedModelId: "claude-sonnet-5",
  role: "orchestrator",
  effort: "high",
};

const resultEvent = (text: string) =>
  JSON.stringify({
    type: "result",
    session_id: "session-1",
    result: text,
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.000003,
      },
    },
  });

const assistantEvent = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

const streamOf =
  (lines: ReadonlyArray<string>): CliStreamRunner =>
  async (_file, _args, _options, onLine) => {
    for (const line of lines) onLine(line);
    return { stderr: "", exitCode: 0 };
  };

test("streaming emits deltas and returns the envelope's completion", async () => {
  const seen: string[] = [];
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    streamOf([
      JSON.stringify({ type: "system", subtype: "init" }),
      assistantEvent("Two systems "),
      assistantEvent("live in that request."),
      resultEvent("Two systems live in that request."),
    ]),
  );

  const completion = await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hello" }],
    512,
    (fragment) => seen.push(fragment),
  );

  assert.deepEqual(seen, ["Two systems ", "live in that request."]);
  // The answer is the envelope's result, never the concatenated deltas. They
  // happen to agree here; the point is which one the code trusts.
  assert.equal(completion.content, "Two systems live in that request.");
  assert.equal(completion.providerRequestId, "session-1");
  assert.equal(completion.resolvedModelId, "claude-sonnet-5");
  assert.equal(completion.usage.outputTokens, 4);
});

test("a malformed progress line is skipped, not fatal", async () => {
  const seen: string[] = [];
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    streamOf([
      assistantEvent("before "),
      "{not json at all",
      assistantEvent("after"),
      resultEvent("before after"),
    ]),
  );

  const completion = await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hello" }],
    512,
    (fragment) => seen.push(fragment),
  );

  // Killing a live answer over one unparseable progress line would trade a real
  // completion for a cosmetic guarantee.
  assert.deepEqual(seen, ["before ", "after"]);
  assert.equal(completion.content, "before after");
});

test("a stream that never produces a result envelope fails closed", async () => {
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    async (_file, _args, _options, onLine) => {
      onLine(assistantEvent("half an answer"));
      return { stderr: "connection reset by peer", exitCode: 1 };
    },
  );

  await assert.rejects(
    adapter.invokeStreaming(
      route,
      [{ role: "user", content: "hello" }],
      512,
      () => {},
    ),
    /claude_cli_exit_1/,
  );
});

test("delta forwarding is bounded by the output ceiling", async () => {
  const seen: string[] = [];
  const huge = "x".repeat(400_000);
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    streamOf([
      assistantEvent(huge),
      assistantEvent(huge),
      assistantEvent(huge),
      assistantEvent("this one is past the ceiling"),
      resultEvent("final"),
    ]),
  );

  await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hello" }],
    512,
    (fragment) => seen.push(fragment),
  );

  // 1,000,000-byte floor: three 400k fragments cross it, the fourth is refused.
  // A provider flooding this process must not be able to grow it without limit
  // on a 7.8 GB host.
  assert.equal(seen.length, 3);
  assert.equal(seen.includes("this one is past the ceiling"), false);
});

class NonStreamingAdapter implements ManagedProviderAdapter {
  readonly provider = "deepseek" as const;
  invoked = 0;
  async listModels() {
    return ["deepseek-v4-flash"];
  }
  async invoke() {
    this.invoked += 1;
    return {
      providerRequestId: "request-1",
      resolvedModelId: "deepseek-v4-flash",
      resolutionSource: "provider_response" as const,
      content: "a buffered answer",
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
          resolvedModelId: "deepseek-v4-flash",
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

test("an adapter without streaming is never wrapped in a fake one", async () => {
  const adapter = new NonStreamingAdapter();
  const gateway = new AiGateway(new MemoryAttemptLedger(), [adapter]);
  const seen: string[] = [];

  const result = await gateway.execute({
    idempotencyKey: "no-stream-1",
    taskClass: "bulk_code",
    routeOverride: modelRoutes("bulk_code")[0]!,
    attribution: {
      projectId: "p",
      contractId: "CONTRACT-016",
      milestoneId: "m",
      taskId: "t",
      taskAttemptOrdinal: 1,
      agentId: "gateway",
    },
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 512,
    maxCostUsdMicros: 200_000,
    policyVersion: MODEL_POLICY_VERSION,
    onDelta: (fragment) => seen.push(fragment),
  });

  // No simulated deltas. Pretending a buffered provider streamed would be a
  // lie told by the UI, and the caller can tell the difference by the absence
  // of deltas rather than by a flag it has to remember to check.
  assert.deepEqual(seen, []);
  assert.equal(adapter.invoked, 1);
  assert.equal(result.content, "a buffered answer");
});

test("streamed and buffered answers settle the ledger the same way", async () => {
  const ledger = new MemoryAttemptLedger();
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    streamOf([assistantEvent("answer"), resultEvent("answer")]),
  );
  const gateway = new AiGateway(ledger, [adapter]);
  const seen: string[] = [];

  const result = await gateway.execute({
    idempotencyKey: "stream-ledger-1",
    taskClass: "orchestration",
    routeOverride: route,
    attribution: {
      projectId: "p",
      contractId: "CONTRACT-016",
      milestoneId: "m",
      taskId: "t",
      taskAttemptOrdinal: 1,
      agentId: "gateway",
    },
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 512,
    maxCostUsdMicros: 200_000,
    policyVersion: MODEL_POLICY_VERSION,
    onDelta: (fragment) => seen.push(fragment),
  });

  // The whole reason invokeStreaming returns a ManagedCompletion rather than a
  // stream: a streamed answer must not reach the ledger by a different route
  // than a buffered one, or the two drift and only one stays tested.
  assert.deepEqual(seen, ["answer"]);
  assert.equal(result.content, "answer");
  assert.equal(result.attempt.outcome, "succeeded");
  assert.equal(result.attempt.route.provider, "claude");
  assert.ok(result.attempt.usage!.costUsdMicros > 0);
});
