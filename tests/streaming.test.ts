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

const route: ModelRoute = modelRoutes("orchestration").find(
  (candidate) =>
    candidate.provider === "claude" &&
    candidate.requestedModelId === "claude-sonnet-5",
)!;

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

const partialDelta = (text: string) =>
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });

test("token-level deltas are emitted as they arrive", async () => {
  // The shape was captured from real CLI output under
  // --include-partial-messages, not inferred: an earlier version of this
  // adapter read only whole `assistant` events, which is why a real run
  // produced exactly one 938-character fragment instead of a stream.
  const seen: string[] = [];
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    streamOf([
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_start" },
      }),
      partialDelta("Batas "),
      partialDelta("otoritas "),
      partialDelta("lebih penting."),
      resultEvent("Batas otoritas lebih penting."),
    ]),
  );

  const completion = await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hello" }],
    512,
    (fragment) => seen.push(fragment),
  );

  assert.deepEqual(seen, ["Batas ", "otoritas ", "lebih penting."]);
  assert.equal(completion.content, "Batas otoritas lebih penting.");
});

test("the final assistant event does not double an already-streamed answer", async () => {
  // With --include-partial-messages the CLI emits BOTH the deltas and a
  // complete `assistant` message carrying the same text. Emitting both would
  // show every answer twice.
  const seen: string[] = [];
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    streamOf([
      partialDelta("once "),
      partialDelta("only"),
      assistantEvent("once only"),
      resultEvent("once only"),
    ]),
  );

  await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hello" }],
    512,
    (fragment) => seen.push(fragment),
  );

  assert.deepEqual(seen, ["once ", "only"]);
  assert.equal(seen.join(""), "once only");
});

test("a CLI build without partial messages still streams whole messages", async () => {
  // The fallback must stay: if no delta ever arrives, the complete assistant
  // event is the only text there is, and dropping it would mean no progress at
  // all rather than coarse progress.
  const seen: string[] = [];
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    streamOf([assistantEvent("whole answer"), resultEvent("whole answer")]),
  );

  await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hello" }],
    512,
    (fragment) => seen.push(fragment),
  );

  assert.deepEqual(seen, ["whole answer"]);
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
    return ["deepseek-v4-pro", "deepseek-v4-flash"];
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
  // Usage really was settled, asserted on tokens rather than dollars.
  //
  // This used to assert `costUsdMicros > 0`, which quietly depended on the
  // ledger recording a cost for Claude -- and Claude is reached over a
  // subscription, where no per-token charge exists. The CLI reports what the
  // tokens *would* have cost on metered pricing and the gateway banked it, so
  // this assertion was passing on money nobody was ever charged. Tokens are
  // the real signal for a subscription plan; the dollar figure is now zero and
  // that is the truthful value.
  assert.ok(result.attempt.usage!.inputTokens > 0);
  assert.ok(result.attempt.usage!.outputTokens > 0);
  assert.equal(result.attempt.usage!.costUsdMicros, 0);
});

test("the prompt never appears in argv", async () => {
  // argv is world-readable through /proc/<pid>/cmdline, and the prompt is the
  // owner's whole conversation. This repository already forbids secrets in
  // argv; a private conversation deserves the same treatment.
  const secretish = "OWNER_PRIVATE_PLANNING_TEXT";
  let seenArgs: ReadonlyArray<string> = [];
  let seenInput: string | undefined;

  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    async (_file, args, options, onLine) => {
      seenArgs = args;
      seenInput = options.input;
      onLine(resultEvent("ok"));
      return { stderr: "", exitCode: 0 };
    },
  );
  await adapter.invokeStreaming(
    route,
    [{ role: "user", content: secretish }],
    512,
    () => {},
  );

  assert.equal(
    seenArgs.some((arg) => arg.includes(secretish)),
    false,
    "prompt leaked into argv",
  );
  assert.ok(seenInput?.includes(secretish), "prompt must arrive on stdin");
});

test("tools are allowed by name when capability is granted, never bypassed", async () => {
  // The CLI refuses --permission-mode bypassPermissions as root, and this
  // service must run as root to reach a repository under /root. Pre-approving
  // named tools avoids the prompt without the blanket bypass, which is what
  // makes both requirements satisfiable at once.
  let seenArgs: ReadonlyArray<string> = [];
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    async (_f, args, _o, onLine) => {
      seenArgs = args;
      onLine(resultEvent("ok"));
      return { stderr: "", exitCode: 0 };
    },
    { tools: true, workingDirectory: "/tmp" },
  );
  await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hi" }],
    512,
    () => {},
  );

  assert.ok(seenArgs.includes("--allowedTools"));
  assert.ok(seenArgs.includes("Bash"));
  assert.equal(
    seenArgs.includes("--permission-mode"),
    false,
    "root refuses bypass",
  );
  assert.equal(seenArgs.includes("--disallowedTools"), false);
  // Investigating costs turns: read, grep, then answer. Three was sized for a
  // single buffered reply and produced claude_max_turns the first time tools
  // were enabled.
  assert.equal(seenArgs[seenArgs.indexOf("--max-turns") + 1], "12");
});

test("the provider is invoked with tools denied by default", async () => {
  // This CLI is Claude Code: as a provider it otherwise arrives with Bash,
  // Edit, Read and the rest, running as the service user. That would void the
  // authority claim that nothing executes because a chat asked for it -- the
  // provider could execute while composing the answer, outside the proposal
  // gate.
  let seenArgs: ReadonlyArray<string> = [];
  const adapter = new ClaudeCliAdapter(
    undefined,
    3,
    async (_file, args, _options, onLine) => {
      seenArgs = args;
      onLine(resultEvent("ok"));
      return { stderr: "", exitCode: 0 };
    },
  );
  await adapter.invokeStreaming(
    route,
    [{ role: "user", content: "hello" }],
    512,
    () => {},
  );

  assert.ok(seenArgs.includes("--disallowedTools"));
  for (const tool of ["Bash", "Edit", "Write", "Read", "Task", "WebFetch"])
    assert.ok(seenArgs.includes(tool), `${tool} must be denied`);
});
