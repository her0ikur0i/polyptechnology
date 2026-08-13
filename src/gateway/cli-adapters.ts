import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
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
  options: {
    signal?: AbortSignal;
    timeout: number;
    maxBuffer: number;
    // The prompt, delivered on stdin rather than as an argv element.
    //
    // argv is world-readable through /proc/<pid>/cmdline, and the prompt is the
    // owner's entire conversation history. This repository already forbids
    // secrets in argv for exactly that reason; a private conversation deserves
    // the same treatment. Found while fixing an unrelated failure, which is the
    // only reason it was noticed at all.
    input?: string;
    // Where the CLI runs. For a tool-enabled provider this is what it can
    // see, so it is the difference between a useful assistant and one that
    // answers questions about an empty release directory.
    cwd?: string;
  },
) => Promise<CliResult>;
const defaultRunner: CliRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { ...options, ...(options.cwd ? { cwd: options.cwd } : {}) },
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
    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
  });
// The Claude CLI's terminal envelope, identical whether it arrives as the whole
// stdout of --output-format json or as the final `result` event of
// --output-format stream-json. Named rather than inlined so both paths are
// provably talking about the same shape.
export interface ClaudeEnvelope {
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
}

// Only the fields this adapter reads. Everything else the CLI emits is ignored
// on purpose: reacting to more of the stream than the answer text and the final
// envelope would couple us to a format we do not control.
interface ClaudeStreamEvent {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  // --include-partial-messages wraps the provider's own SSE events. This is
  // where token-level text actually arrives:
  //   {"type":"stream_event","event":{"type":"content_block_delta",
  //     "delta":{"type":"text_delta","text":"1"}}}
  // Confirmed by capturing real CLI output, not inferred.
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
}

export type CliStreamRunner = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    signal?: AbortSignal;
    timeout: number;
    input?: string;
    cwd?: string;
  },
  onLine: (line: string) => void,
) => Promise<{ stderr: string; exitCode: number }>;

// spawn, not execFile: execFile resolves only at exit, so nothing it produces
// can be seen early by definition. stdout is newline-delimited JSON, and a
// chunk boundary can fall mid-line, so a partial line is carried forward rather
// than parsed and dropped.
// A single NDJSON line larger than this is not a line, it is a malformed
// stream. Without the cap, one unterminated line buffers without bound: the M4
// review drove a 10 MB unbroken line through this and watched RSS grow ~142 MB,
// with nothing to stop it at 100 MB or 1 GB either. The delta ceiling does not
// help, because it only gates text *after* a complete line has been parsed.
const MAX_STREAM_LINE_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 64_000;

export const defaultStreamRunner: CliStreamRunner = (
  file,
  args,
  options,
  onLine,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
    let pending = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece: string) => {
      pending += piece;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim().length > 0) onLine(line);
      if (pending.length > MAX_STREAM_LINE_BYTES) {
        // Hand it over as-is rather than dropping silently: it will fail to
        // parse and be skipped by the caller, which is the honest outcome for
        // a line that never terminated, and memory returns to bounded.
        onLine(pending);
        pending = "";
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (piece: string) => {
      // Keep the TAIL, not the head. The diagnostic built from this takes the
      // last line, so capping by refusing to append once full threw away
      // precisely the line worth reading -- the M4 review reproduced this by
      // writing 70 kB of filler followed by the real auth error, and watched
      // the error vanish.
      stderr = (stderr + piece).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (pending.trim().length > 0) onLine(pending);
      if (timedOut) {
        // Node reports a SIGKILLed child as code=null, so `code ?? 0` used to
        // report a clean exit 0 for a process this runner had just force-killed
        // -- actively misleading anyone triaging a costed-call failure. The
        // buffered execFile path rejects in the equivalent case; this now
        // matches it.
        reject(
          new Error(
            `claude_cli_timeout_after_${options.timeout}ms:${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "no output"}`,
          ),
        );
        return;
      }
      resolve({ stderr, exitCode: code ?? (signal === null ? 0 : -1) });
    });
  });

export class ClaudeCliAdapter implements ManagedProviderAdapter {
  readonly provider = "claude" as const;
  constructor(
    private readonly runner: CliRunner = defaultRunner,
    private readonly maxTurns = 3,
    private readonly streamRunner: CliStreamRunner = defaultStreamRunner,
    // Owner-authorised capability, off by default.
    //
    // This CLI is Claude Code: given tools it can read and change whatever the
    // service user can reach, from inside the working directory below. The
    // owner asked for exactly that on 2026-08-10 after the trade-off was put to
    // them plainly. Default-off keeps every other caller -- and any future
    // deployment that has not made that choice -- on the restricted path.
    private readonly capability: {
      tools?: boolean;
      workingDirectory?: string;
    } = {},
  ) {}
  async listModels() {
    return [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
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
    resumeSessionId?: string,
  ): Promise<ManagedCompletion> {
    const args = this.argsFor(route, "json", resumeSessionId);
    const { stdout, stderr, exitCode } = await this.runner("claude", args, {
      ...(signal === undefined ? {} : { signal }),
      timeout: 180_000,
      maxBuffer: Math.max(1_000_000, maxOutputTokens * 8),
      input: this.promptFor(messages),
      ...(this.capability.workingDirectory
        ? { cwd: this.capability.workingDirectory }
        : {}),
    });
    let body: ClaudeEnvelope;
    try {
      body = JSON.parse(stdout) as ClaudeEnvelope;
    } catch {
      throw new Error(
        `claude_cli_exit_${exitCode}:${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "invalid output"}`,
      );
    }
    return this.completionFrom(body, route);
  }

  // Streaming twin of invoke(), used by AiGateway when the caller asked for
  // deltas. It runs the same CLI with --output-format stream-json instead of
  // json, over spawn instead of execFile, because execFile by definition
  // buffers everything until exit -- there is no way to see a token early
  // through it.
  //
  // The final `result` event carries the identical envelope the non-streaming
  // format returns, which is what makes this safe: both paths converge on
  // completionFrom() for validation and accounting. Duplicating that logic is
  // exactly how the CONTRACT-011 envelope incident happened, so there is one
  // copy and both callers use it.
  async invokeStreaming(
    route: ModelRoute,
    messages: GatewayRequest["messages"],
    maxOutputTokens: number,
    onDelta: (fragment: string) => void,
    signal?: AbortSignal,
    resumeSessionId?: string,
  ): Promise<ManagedCompletion> {
    const args = this.argsFor(route, "stream-json", resumeSessionId);
    let envelope: ClaudeEnvelope | undefined;
    // The same ceiling invoke() gives execFile as maxBuffer. Without it the
    // streaming path would forward unbounded text from a provider that
    // misbehaves, on a 7.8 GB host. Past the ceiling deltas stop being
    // forwarded and the answer simply stops appearing to grow; the result
    // envelope still decides what the answer actually is, so nothing is lost
    // but the progress illusion.
    const deltaCeiling = Math.max(1_000_000, maxOutputTokens * 8);
    let deltaBytes = 0;
    let sawPartialDeltas = false;
    const { stderr, exitCode } = await this.streamRunner(
      "claude",
      args,
      {
        ...(signal === undefined ? {} : { signal }),
        timeout: 180_000,
        input: this.promptFor(messages),
        ...(this.capability.workingDirectory
          ? { cwd: this.capability.workingDirectory }
          : {}),
      },
      (line) => {
        // A malformed line is skipped rather than fatal: the answer's truth is
        // the result envelope, and killing a live answer over one unparseable
        // progress line would trade a real completion for a cosmetic
        // guarantee. If the envelope never arrives, the check below fails
        // closed anyway.
        let event: ClaudeStreamEvent;
        try {
          event = JSON.parse(line) as ClaudeStreamEvent;
        } catch {
          return;
        }
        if (event.type === "result") {
          envelope = event as unknown as ClaudeEnvelope;
          return;
        }
        if (deltaBytes >= deltaCeiling) return;

        // Token-level text, from --include-partial-messages. This is what makes
        // an answer appear as it is written rather than arriving whole.
        if (event.type === "stream_event") {
          const delta = event.event;
          if (
            delta?.type === "content_block_delta" &&
            delta.delta?.type === "text_delta" &&
            typeof delta.delta.text === "string"
          ) {
            sawPartialDeltas = true;
            deltaBytes += delta.delta.text.length;
            onDelta(delta.delta.text);
          }
          return;
        }

        // The complete assistant message. With partial messages enabled this
        // arrives *in addition to* the deltas above and carries the same text,
        // so emitting both would double every answer. It is only used as the
        // fallback for a CLI build that does not support partial messages.
        if (event.type !== "assistant" || sawPartialDeltas) return;
        for (const block of event.message?.content ?? [])
          if (block.type === "text" && typeof block.text === "string") {
            deltaBytes += block.text.length;
            onDelta(block.text);
          }
      },
    );
    if (envelope === undefined)
      throw new Error(
        `claude_cli_exit_${exitCode}:${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "stream ended without a result event"}`,
      );
    return this.completionFrom(envelope, route);
  }

  // The prompt is returned separately from the flags, because it now goes on
  // stdin rather than into argv.
  private promptFor(messages: GatewayRequest["messages"]): string {
    return messages
      .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
      .join("\n\n");
  }

  private argsFor(
    route: ModelRoute,
    outputFormat: "json" | "stream-json",
    resumeSessionId?: string,
  ): string[] {
    return [
      "-p",
      // Resume the provider's own session instead of re-sending the thread.
      //
      // First, so a malformed id fails the invocation immediately rather than
      // after the CLI has parsed a prompt. The id is provider-supplied and
      // length-bounded by the schema that stores it, and it travels as its own
      // argv element -- never concatenated into a string a shell would parse.
      ...(resumeSessionId === undefined ? [] : ["--resume", resumeSessionId]),
      "--model",
      route.requestedModelId,
      "--effort",
      route.effort ?? "high",
      "--max-turns",
      // Investigating with tools costs turns: read a directory, grep a file,
      // then answer. Three was sized for a single buffered reply and is what
      // produced claude_max_turns the first time tools were tried.
      String(this.capability.tools === true ? 12 : this.maxTurns),
      "--output-format",
      outputFormat,
      // --include-partial-messages is what turns stream-json from
      // "whole messages as they complete" into token-level deltas.
      ...(outputFormat === "stream-json"
        ? ["--verbose", "--include-partial-messages"]
        : []),
      // The provider must not have tools.
      //
      // This CLI is Claude Code: invoked as a provider it arrives with Bash,
      // Edit, Read, WebFetch and the rest, running as the service user in the
      // release directory. That silently voids this system's central authority
      // claim -- ADR-0002 says nothing executes because a chat asked for it,
      // but the *provider* could execute while composing the answer, entirely
      // outside the proposal gate.
      //
      // Found when a Telegram question ("how many contracts are in this
      // project?") made the model try to investigate with those tools, burn its
      // turn budget and return claude_max_turns with no answer. The visible
      // symptom was a failed reply; the real problem was that it could have
      // succeeded.
      //
      // Listed explicitly rather than via an empty --allowedTools, because that
      // flag is variadic and swallows the next argument.
      ...(this.capability.tools === true
        ? // Tools on, at the owner's instruction, via an explicit allow-list.
          //
          // NOT --permission-mode bypassPermissions: the CLI refuses that
          // outright when running as root ("cannot be used with root/sudo
          // privileges"), and this service must run as root to reach a
          // repository under /root at all. Pre-approving named tools avoids the
          // prompt without asking for the blanket bypass, so the two
          // requirements stop being mutually exclusive.
          //
          // Safe to pass as a variadic flag only because the prompt now travels
          // on stdin; as an argv element it would have been swallowed as a tool
          // name.
          [
            "--allowedTools",
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "WebFetch",
            "WebSearch",
            "NotebookEdit",
          ]
        : [
            "--disallowedTools",
            "Bash",
            "Edit",
            "Write",
            "Read",
            "Glob",
            "Grep",
            "Task",
            "WebFetch",
            "WebSearch",
            "NotebookEdit",
            "Skill",
            "ToolSearch",
            "TaskCreate",
            "TaskUpdate",
            "SendMessage",
          ]),
    ];
  }

  private completionFrom(
    body: ClaudeEnvelope,
    route: ModelRoute,
  ): ManagedCompletion {
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
    // An empty modelUsage is not a per-model mismatch: the CLI produced no model
    // accounting at all, which is what a usage-limited or otherwise unavailable
    // provider looks like (it never billed a model). Surface it as a distinct,
    // known, non-unknown failure so the gateway can mark the provider
    // unavailable and the escalation chain can skip the tier instead of
    // retrying a dead one.
    if (models.length === 0)
      throw new ManagedInvocationError("model_absent", false);
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
    return ["gpt-5.5", "gpt-5.6"];
  }
  private cliModelId(requestedModelId: string) {
    return requestedModelId === "gpt-5.6" ? "gpt-5.6-sol" : requestedModelId;
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
    // An empty directory that exists only for this call. Created per
    // invocation and left for the OS to reap: it is the agent's working root,
    // so it must contain nothing worth reading and nothing worth writing to.
    const sandboxDir = await mkdtemp(join(tmpdir(), "polyp-codex-"));
    const { stdout, stderr, exitCode } = await this.runner(
      "codex",
      [
        "exec",
        "--json",
        // Codex refuses to start outside a git repository it trusts:
        //   "Not inside a trusted directory and --skip-git-repo-check was not
        //    specified."
        //
        // The supervisor runs with WorkingDirectory=/opt/polyp-ai-factory/current,
        // which is not one, so **every Codex attempt this system has ever made
        // failed on startup** -- the technical-fallback tier was configured,
        // routed to, and had never once produced a completion.
        //
        // Skipping that check on its own would be a real escalation, and the
        // security review caught it: `codex exec` is Codex's *agentic*
        // entrypoint, not a completion endpoint. The trust check is what had
        // been standing between a model and the deployed application tree --
        // source, config and node_modules -- as its working root. Removing the
        // guard without replacing it would have handed an untrusted model
        // default write and command permissions there.
        //
        // So the guard is replaced rather than removed. The three flags below
        // state the boundary explicitly instead of inheriting whatever the CLI
        // defaults to in a directory nobody vetted:
        "--skip-git-repo-check",
        // Working root: a directory created for this call and nothing else.
        // Never the release tree, never a project workspace.
        "--cd",
        sandboxDir,
        // No writes and no command execution, whatever the prompt asks for.
        "--sandbox",
        "read-only",
        // There is deliberately no --ask-for-approval here: `codex exec` does
        // not accept one, because it is the non-interactive entrypoint and has
        // no terminal to ask at. The sandbox above is the control, not a
        // prompt nobody could answer.
        "--model",
        this.cliModelId(route.requestedModelId),
        "--config",
        `model_reasoning_effort=${route.effort ?? "high"}`,
        // Prompt omitted here on purpose -- see `input` below. Same reasoning
        // as the Claude adapter: argv is world-readable through /proc.
      ],
      {
        ...(signal === undefined ? {} : { signal }),
        // Ten minutes, raised from five.
        //
        // On the first genuinely hard brief, three consecutive Codex attempts
        // died with `invalid Codex JSONL telemetry` -- the stream carried
        // `thread.started` and `turn.started` and no completed item, which is
        // what a killed process leaves behind. Harder work legitimately takes
        // longer, and the work engine's lease is heartbeated, so a long call
        // costs nothing but time. The task's own maxAttempts still bounds it.
        timeout: 600_000,
        maxBuffer: Math.max(1_000_000, maxOutputTokens * 8),
        input: prompt,
      },
    );
    // Empty stdout means the CLI produced no telemetry at all -- it refused to
    // start, failed to parse its own arguments, or died before reporting.
    //
    // This used to be flagged `outcomeUnknown: true`, which tells the ledger to
    // **hold the attempt's budget reservation permanently**, because an unknown
    // outcome might have been charged. For a local process that never emitted a
    // single line, that is the wrong reading: nothing was charged, and the money
    // was held anyway. On staging it had accumulated **$6.70 held against $1.84
    // actually spent**, and three such failures were enough to exhaust a $2.00
    // generation scope -- which capped the escalation chain at roughly three
    // tiers no matter what `maxAttempts` said. The tier that could not be
    // reached was the fallback tier that exists for when the earlier ones fail.
    //
    // The discriminator is structural, not a string match: no stdout means no
    // provider response was ever parsed, so there is nothing to reconcile.
    // Partial output still counts as unknown, below.
    if (stdout.trim().length === 0)
      throw new ManagedInvocationError(
        `codex_cli_exit_${exitCode}:${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "empty output"}`,
        false,
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
