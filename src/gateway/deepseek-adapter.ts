import type {
  GatewayRequest,
  ManagedCompletion,
  ManagedProviderAdapter,
  ModelRoute,
  NormalizedUsage,
} from "./types.js";
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
export class DeepSeekAdapter implements ManagedProviderAdapter {
  readonly provider = "deepseek" as const;
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
    const response = await this.request("/chat/completions", {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
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
