export type ProviderErrorCode =
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "unavailable"
  | "invalid_request"
  | "cancelled";
export interface CompletionRequest {
  model: string;
  messages: ReadonlyArray<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  maxOutputTokens: number;
  signal?: AbortSignal;
}
export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  providerRequestId: string;
}
export interface ProviderAdapter {
  readonly providerId: string;
  listModels(): Promise<ReadonlyArray<string>>;
  health(): Promise<"healthy" | "degraded" | "down">;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
export class NormalizedProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
export class FakeProviderAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string,
    private readonly models: ReadonlyArray<string>,
    private readonly response = "ok",
  ) {}
  async listModels() {
    return [...this.models];
  }
  async health() {
    return "healthy" as const;
  }
  async complete(request: CompletionRequest) {
    if (request.signal?.aborted)
      throw new NormalizedProviderError(
        "cancelled",
        "request cancelled",
        false,
      );
    return {
      content: this.response,
      inputTokens: request.messages.length,
      outputTokens: 1,
      providerRequestId: `fake-${this.providerId}`,
    };
  }
}
