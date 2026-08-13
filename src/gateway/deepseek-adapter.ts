import type {
  GatewayRequest,
  ManagedCompletion,
  ManagedProviderAdapter,
  ModelRoute,
  NormalizedUsage,
} from "./types.js";
import { ManagedInvocationError } from "./types.js";
export interface SecretResolver {
  resolve(reference: string): Promise<string>;
}
type DeepSeekResponse = {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};
type DeepSeekStreamChunk = DeepSeekResponse & {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
};
export class DeepSeekAdapter implements ManagedProviderAdapter {
  readonly provider = "deepseek" as const;
  private static readonly COMPLETION_TIMEOUT_MS = 15 * 60_000;
  constructor(
    private readonly baseUrl: string,
    private readonly secretRef: string,
    private readonly secrets: SecretResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async listModels() {
    const response = await this.request("/models", { method: "GET" });
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).flatMap((item) =>
      typeof item.id === "string" ? [item.id] : [],
    );
  }
  async invoke(
    route: ModelRoute,
    messages: GatewayRequest["messages"],
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<ManagedCompletion> {
    if (route.provider !== this.provider)
      throw new Error("adapter route mismatch");
    // A large thinking allowance can legitimately take several minutes, but
    // fetch has no timeout of its own. Bound the provider call so a lost
    // upstream connection cannot retain a task lease forever.
    const timeoutSignal = AbortSignal.timeout(
      DeepSeekAdapter.COMPLETION_TIMEOUT_MS,
    );
    const requestSignal =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal]);
    const response = await this.request("/chat/completions", {
      method: "POST",
      signal: requestSignal,
      body: JSON.stringify({
        model: route.requestedModelId,
        messages,
        max_tokens: maxOutputTokens,
        stream: false,
        ...(route.mode
          ? {
              thinking: {
                type: route.mode === "thinking" ? "enabled" : "disabled",
              },
            }
          : {}),
      }),
    });
    const body = (await response.json()) as DeepSeekResponse;
    if (
      typeof body.id !== "string" ||
      typeof body.model !== "string" ||
      typeof body.choices?.[0]?.message?.content !== "string" ||
      body.choices[0].message.content.trim().length === 0 ||
      body.usage === undefined
    )
      throw new Error("invalid DeepSeek response");
    const usage: NormalizedUsage = {
      inputTokens: this.integer(body.usage.prompt_tokens),
      outputTokens: this.integer(body.usage.completion_tokens),
      reasoningTokens: this.integer(
        body.usage.completion_tokens_details?.reasoning_tokens,
      ),
      cacheReadTokens: this.integer(body.usage.prompt_cache_hit_tokens),
      cacheWriteTokens: 0,
      costUsdMicros: this.cost(route.requestedModelId, body.usage),
    };
    return {
      providerRequestId: body.id,
      resolvedModelId: body.model,
      resolutionSource: "provider_response",
      content: body.choices[0]!.message!.content!,
      usage,
      modelUsage: [{ resolvedModelId: body.model, ...usage }],
    };
  }
  async invokeStreaming(
    route: ModelRoute,
    messages: GatewayRequest["messages"],
    maxOutputTokens: number,
    onDelta: (fragment: string) => void,
    signal?: AbortSignal,
  ): Promise<ManagedCompletion> {
    if (route.provider !== this.provider)
      throw new Error("adapter route mismatch");
    const timeoutSignal = AbortSignal.timeout(
      DeepSeekAdapter.COMPLETION_TIMEOUT_MS,
    );
    const requestSignal =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal]);
    const response = await this.request("/chat/completions", {
      method: "POST",
      signal: requestSignal,
      body: JSON.stringify({
        model: route.requestedModelId,
        messages,
        max_tokens: maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(route.mode
          ? {
              thinking: {
                type: route.mode === "thinking" ? "enabled" : "disabled",
              },
            }
          : {}),
      }),
    });
    if (response.body === null) throw new Error("invalid DeepSeek stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let id: string | undefined;
    let model: string | undefined;
    let usage: DeepSeekResponse["usage"];
    let content = "";
    let reasoningChars = 0;
    let doneSeen = false;
    const consume = (event: string) => {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data.length === 0) continue;
        if (data === "[DONE]") {
          doneSeen = true;
          continue;
        }
        const chunk = JSON.parse(data) as DeepSeekStreamChunk;
        id = chunk.id ?? id;
        model = chunk.model ?? model;
        usage = chunk.usage ?? usage;
        const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
        if (typeof reasoning === "string") reasoningChars += reasoning.length;
        const fragment = chunk.choices?.[0]?.delta?.content;
        if (typeof fragment === "string" && fragment.length > 0) {
          content += fragment;
          onDelta(fragment);
        }
      }
    };
    const diagnostic = () =>
      [
        id === undefined ? "id=0" : "id=1",
        model === undefined ? "model=0" : "model=1",
        `reasoning_chars=${reasoningChars}`,
        `content_chars=${content.length}`,
        usage === undefined ? "usage=0" : "usage=1",
        doneSeen ? "done=1" : "done=0",
      ].join(";");
    try {
      for (;;) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) consume(event);
        if (next.done) break;
      }
      if (buffer.trim().length > 0) consume(buffer);
    } catch (error) {
      const detail =
        error instanceof Error ? `${error.name}:${error.message}` : "unknown";
      const code = `${
        timeoutSignal.aborted
          ? "deepseek_stream_timeout"
          : requestSignal.aborted
            ? "deepseek_stream_aborted"
            : "deepseek_stream_terminated"
      }:${diagnostic()};detail=${detail}`.slice(0, 500);
      throw new ManagedInvocationError(code, true, id);
    }
    if (id === undefined || model === undefined || content.trim().length === 0)
      throw new ManagedInvocationError(
        `deepseek_stream_incomplete:${diagnostic()}`.slice(0, 500),
        true,
        id,
      );
    const safeUsage = usage ?? {};
    const normalized: NormalizedUsage = {
      inputTokens: this.integer(safeUsage.prompt_tokens),
      outputTokens: this.integer(safeUsage.completion_tokens),
      reasoningTokens: this.integer(
        safeUsage.completion_tokens_details?.reasoning_tokens,
      ),
      cacheReadTokens: this.integer(safeUsage.prompt_cache_hit_tokens),
      cacheWriteTokens: 0,
      costUsdMicros: this.cost(route.requestedModelId, safeUsage),
    };
    return {
      providerRequestId: id,
      resolvedModelId: model,
      resolutionSource: "provider_response",
      content,
      usage: normalized,
      modelUsage: [{ resolvedModelId: model, ...normalized }],
    };
  }
  private async request(path: string, init: RequestInit) {
    const key = await this.secrets.resolve(this.secretRef);
    if (key.length < 16) throw new Error("provider credential unavailable");
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, "")}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
      },
    );
    if (!response.ok) throw new Error(`deepseek_http_${response.status}`);
    return response;
  }
  private integer(value: number | undefined) {
    return Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
  }
  private cost(model: string, usage: NonNullable<DeepSeekResponse["usage"]>) {
    const hit = this.integer(usage.prompt_cache_hit_tokens),
      input = this.integer(usage.prompt_tokens),
      miss = Math.max(0, input - hit),
      output = this.integer(usage.completion_tokens);
    const prices =
      model === "deepseek-v4-pro"
        ? { hit: 3625, miss: 435000, out: 870000 }
        : { hit: 2800, miss: 140000, out: 280000 };
    return Math.ceil(
      (hit * prices.hit + miss * prices.miss + output * prices.out) / 1_000_000,
    );
  }
}
