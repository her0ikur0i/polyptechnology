import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekAdapter } from "../src/gateway/deepseek-adapter.js";
import { ManagedInvocationError } from "../src/gateway/types.js";

const route = {
  provider: "deepseek" as const,
  requestedModelId: "deepseek-v4-pro",
  role: "primary-executor",
  mode: "thinking" as const,
};

function adapter(content: string) {
  return new DeepSeekAdapter(
    "https://deepseek.invalid",
    "secret://polyp/deepseek/api-key",
    {
      async resolve() {
        return "a-valid-test-secret";
      },
    },
    async () =>
      new Response(
        JSON.stringify({
          id: "request-1",
          model: "deepseek-v4-pro",
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 1, completion_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
}

test("DeepSeek rejects an empty completion as a protocol failure", async () => {
  await assert.rejects(
    adapter("").invoke(route, [{ role: "user", content: "write code" }], 100),
    /invalid DeepSeek response/,
  );
});

test("DeepSeek rejects a whitespace-only completion as a protocol failure", async () => {
  await assert.rejects(
    adapter(" \n\t").invoke(
      route,
      [{ role: "user", content: "write code" }],
      100,
    ),
    /invalid DeepSeek response/,
  );
});

test("DeepSeek streaming keeps reasoning traffic alive and accumulates content", async () => {
  const events = [
    {
      id: "request-stream",
      model: "deepseek-v4-pro",
      choices: [{ delta: { reasoning_content: "thinking" } }],
    },
    {
      id: "request-stream",
      model: "deepseek-v4-pro",
      choices: [{ delta: { content: "diff --git " } }],
    },
    {
      id: "request-stream",
      model: "deepseek-v4-pro",
      choices: [{ delta: { content: "a/x b/x\n" } }],
    },
    {
      id: "request-stream",
      model: "deepseek-v4-pro",
      choices: [],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const instance = new DeepSeekAdapter(
    "https://deepseek.invalid",
    "secret://polyp/deepseek/api-key",
    {
      async resolve() {
        return "a-valid-test-secret";
      },
    },
    async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const deltas: string[] = [];
  const result = await instance.invokeStreaming(
    route,
    [{ role: "user", content: "write code" }],
    128_000,
    (fragment) => deltas.push(fragment),
  );
  assert.equal(result.content, "diff --git a/x b/x\n");
  assert.deepEqual(deltas, ["diff --git ", "a/x b/x\n"]);
  assert.equal(result.usage.reasoningTokens, 4);
});

test("DeepSeek streaming accepts content even when final usage is absent", async () => {
  const events = [
    {
      id: "request-stream",
      model: "deepseek-v4-pro",
      choices: [{ delta: { content: "diff --git a/x b/x\n" } }],
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const instance = new DeepSeekAdapter(
    "https://deepseek.invalid",
    "secret://polyp/deepseek/api-key",
    {
      async resolve() {
        return "a-valid-test-secret";
      },
    },
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const result = await instance.invokeStreaming(
    route,
    [{ role: "user", content: "write code" }],
    32_000,
    () => {},
  );
  assert.equal(result.content, "diff --git a/x b/x\n");
  assert.equal(result.usage.inputTokens, 0);
  assert.equal(result.usage.outputTokens, 0);
  assert.equal(result.usage.costUsdMicros, 0);
});

test("DeepSeek streaming wraps transport termination with diagnostics", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: "request-stream",
            model: "deepseek-v4-pro",
            choices: [{ delta: { reasoning_content: "thinking" } }],
          })}\n\n`,
        ),
      );
    },
    pull() {
      throw new Error("terminated");
    },
  });
  const instance = new DeepSeekAdapter(
    "https://deepseek.invalid",
    "secret://polyp/deepseek/api-key",
    {
      async resolve() {
        return "a-valid-test-secret";
      },
    },
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );

  await assert.rejects(
    () =>
      instance.invokeStreaming(
        route,
        [{ role: "user", content: "write code" }],
        32_000,
        () => {},
      ),
    (error) =>
      error instanceof ManagedInvocationError &&
      error.code.startsWith("deepseek_stream_terminated:") &&
      error.code.includes("id=1") &&
      error.code.includes("model=1") &&
      error.code.includes("reasoning_chars=8") &&
      error.code.includes("content_chars=0") &&
      error.code.includes("usage=0") &&
      error.code.includes("done=0") &&
      error.providerRequestId === "request-stream",
  );
});
