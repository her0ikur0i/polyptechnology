import { execFile } from "node:child_process";
import type {
  GatewayRequest,
  ManagedCompletion,
  ManagedProviderAdapter,
  ModelRoute,
} from "./types.js";
import { ManagedInvocationError } from "./types.js";
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type CliRunner = (
  file: string,
  args: ReadonlyArray<string>,
  options: { signal?: AbortSignal; timeout: number; maxBuffer: number },
) => Promise<CliResult>;
const defaultRunner: CliRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      options,
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
    child.stdin?.end();
  });
export class ClaudeCliAdapter implements ManagedProviderAdapter {
  readonly provider = "claude" as const;
  constructor(
    private readonly runner: CliRunner = defaultRunner,
    private readonly maxTurns = 3,
  ) {}
  async listModels() {
    return [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-5",
    ];
  }
  async invoke(
    route: ModelRoute,
    messages: GatewayRequest["messages"],
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<ManagedCompletion> {
    const prompt = messages
      .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
      .join("\n\n");
    const args = [
      "-p",
      "--model",
      route.requestedModelId,
      "--effort",
      route.effort ?? "high",
      "--max-turns",
      String(this.maxTurns),
      "--output-format",
      "json",
      prompt,
    ];
    const { stdout, stderr, exitCode } = await this.runner("claude", args, {
      ...(signal === undefined ? {} : { signal }),
      timeout: 180_000,
      maxBuffer: Math.max(1_000_000, maxOutputTokens * 8),
    });
    let body: {
      session_id?: string;
      result?: string;
      terminal_reason?: string;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      modelUsage?: Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD?: number;
        }
      >;
    };
    try {
      body = JSON.parse(stdout) as typeof body;
    } catch {
      throw new Error(
        `claude_cli_exit_${exitCode}:${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "invalid output"}`,
      );
    }
    if (typeof body.result !== "string" && typeof body.session_id === "string")
      throw new ManagedInvocationError(
        `claude_${body.terminal_reason ?? body.stop_reason ?? "no_result"}`,
        false,
        body.session_id,
      );
    const models = Object.keys(body.modelUsage ?? {});
    if (typeof body.session_id !== "string" || typeof body.result !== "string")
      throw new Error(
        `invalid Claude CLI envelope:${Object.keys(body).sort().join(",")}`,
      );
    if (!models.includes(route.requestedModelId))
      throw new Error(
        `requested Claude model absent:${models.sort().join(",")}`,
      );
    const modelUsage = models.map((resolvedModelId) => {
      const value = body.modelUsage![resolvedModelId]!;
      return {
        resolvedModelId,
        inputTokens: this.integer(value.inputTokens),
        outputTokens: this.integer(value.outputTokens),
        reasoningTokens: 0,
        cacheReadTokens: this.integer(value.cacheReadInputTokens),
        cacheWriteTokens: this.integer(value.cacheCreationInputTokens),
        costUsdMicros: Math.ceil((value.costUSD ?? 0) * 1_000_000),
      };
    });
    return {
      providerRequestId: body.session_id,
      resolvedModelId: route.requestedModelId,
      resolutionSource: "provider_response",
      content: body.result,
      usage: {
        inputTokens: modelUsage.reduce(
          (sum, value) => sum + value.inputTokens,
          0,
        ),
        outputTokens: modelUsage.reduce(
          (sum, value) => sum + value.outputTokens,
          0,
        ),
        reasoningTokens: 0,
        cacheReadTokens: modelUsage.reduce(
          (sum, value) => sum + value.cacheReadTokens,
          0,
        ),
        cacheWriteTokens: modelUsage.reduce(
          (sum, value) => sum + value.cacheWriteTokens,
          0,
        ),
        costUsdMicros: modelUsage.reduce(
          (sum, value) => sum + value.costUsdMicros,
          0,
        ),
      },
      modelUsage,
    };
  }
  private integer(value: number | undefined) {
    return Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
  }
}
export interface CodexJsonResult {
  requestId: string;
  resolvedModelId: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsdMicros: number;
  resolutionSource: "provider_response" | "pinned_request";
}
export function parseCodexJsonl(
  stdout: string,
  requestedModelId: string,
): CodexJsonResult {
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const started = events.find((event) => event.type === "thread.started"),
    completed = [...events]
      .reverse()
      .find((event) => event.type === "turn.completed"),
    messages = events
      .filter((event) => event.type === "item.completed")
      .map(
        (event) => event.item as { type?: string; text?: string } | undefined,
      )
      .filter(
        (item) =>
          item?.type === "agent_message" && typeof item.text === "string",
      );
  const usage = completed?.usage as
    | {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_tokens?: number;
        cost_usd_micros?: number;
      }
    | undefined;
  const reportedModel = events
    .map((event) => event.model)
    .find((value) => typeof value === "string");
  if (
    typeof started?.thread_id !== "string" ||
    messages.length === 0 ||
    usage === undefined
  )
    throw new Error(
      `invalid Codex JSONL telemetry:types=${events.map((event) => String(event.type)).join(",")};started=${Object.keys(
        started ?? {},
      )
        .sort()
        .join(",")};completed=${Object.keys(completed ?? {})
        .sort()
        .join(",")};items=${events
        .filter((event) => event.type === "item.completed")
        .map((event) =>
          String((event.item as { type?: string } | undefined)?.type),
        )
        .join(",")}`,
    );
  return {
    requestId: started.thread_id,
    resolvedModelId:
      typeof reportedModel === "string" ? reportedModel : requestedModelId,
    resolutionSource:
      typeof reportedModel === "string"
        ? "provider_response"
        : "pinned_request",
    content: messages.at(-1)!.text!,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.reasoning_tokens ?? 0,
    cacheReadTokens: usage.cached_input_tokens ?? 0,
    costUsdMicros: usage.cost_usd_micros ?? 0,
  };
}
export class CodexCliAdapter implements ManagedProviderAdapter {
  readonly provider = "codex" as const;
  constructor(
    private readonly runner: CliRunner = defaultRunner,
    private readonly parser: (
      stdout: string,
      requestedModelId: string,
    ) => CodexJsonResult = parseCodexJsonl,
  ) {}
  async listModels() {
    return ["gpt-5.6-terra", "gpt-5.6-sol"];
  }
  async invoke(
    route: ModelRoute,
    messages: GatewayRequest["messages"],
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<ManagedCompletion> {
    const prompt = messages
      .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
      .join("\n\n");
    const { stdout, stderr, exitCode } = await this.runner(
      "codex",
      [
        "exec",
        "--json",
        "--model",
        route.requestedModelId,
        "--config",
        `model_reasoning_effort=${route.effort ?? "high"}`,
        prompt,
      ],
      {
        ...(signal === undefined ? {} : { signal }),
        timeout: 300_000,
        maxBuffer: Math.max(1_000_000, maxOutputTokens * 8),
      },
    );
    if (stdout.trim().length === 0)
      throw new ManagedInvocationError(
        `codex_cli_exit_${exitCode}:${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "empty output"}`,
        true,
      );
    const body = this.parser(stdout, route.requestedModelId);
    if (!body.requestId || !body.resolvedModelId || !body.content)
      throw new Error("invalid Codex CLI telemetry");
    return {
      providerRequestId: body.requestId,
      resolvedModelId: body.resolvedModelId,
      resolutionSource: body.resolutionSource,
      content: body.content,
      usage: {
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        reasoningTokens: body.reasoningTokens,
        cacheReadTokens: body.cacheReadTokens,
        cacheWriteTokens: 0,
        costUsdMicros: body.costUsdMicros,
      },
      modelUsage: [
        {
          resolvedModelId: body.resolvedModelId,
          inputTokens: body.inputTokens,
          outputTokens: body.outputTokens,
          reasoningTokens: body.reasoningTokens,
          cacheReadTokens: body.cacheReadTokens,
          cacheWriteTokens: 0,
          costUsdMicros: body.costUsdMicros,
        },
      ],
    };
  }
}
