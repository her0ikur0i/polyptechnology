import { createHash } from "node:crypto";
import type { OperationDriver } from "./execution-supervisor.js";
import type { AiGateway } from "../gateway/gateway.js";
import type { ConversationStore } from "../orchestrator/types.js";
import type { GatewayAttribution, ModelRoute } from "../gateway/types.js";
import { deterministicUuid } from "../deterministic-id.js";

export interface ConversationReplyTaskInput {
  conversationId: string;
  projectId: string;
  // The conversation's version immediately after the owner's message that
  // triggered this reply was appended -- appendMessage()'s optimistic
  // concurrency check means the reply fails closed (not silently
  // reordered) if another message lands in between.
  expectedVersion: number;
  idempotencyKey: string;
  attribution: GatewayAttribution;
  maxOutputTokens: number;
  maxCostUsdMicros: number;
  policyVersion: string;
  route: ModelRoute;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(
      `conversation_reply input: ${label} must be a nonblank string`,
    );
  return value;
}

export function parseConversationReplyTaskInput(
  raw: unknown,
): ConversationReplyTaskInput {
  if (typeof raw !== "object" || raw === null)
    throw new Error("conversation_reply input must be an object");
  const input = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    (input.expectedVersion as number) < 0
  )
    throw new Error("conversation_reply input: expectedVersion invalid");
  return {
    conversationId: assertString(input.conversationId, "conversationId"),
    projectId: assertString(input.projectId, "projectId"),
    expectedVersion: input.expectedVersion as number,
    idempotencyKey: assertString(input.idempotencyKey, "idempotencyKey"),
    attribution: input.attribution as GatewayAttribution,
    maxOutputTokens: input.maxOutputTokens as number,
    maxCostUsdMicros: input.maxCostUsdMicros as number,
    policyVersion: assertString(input.policyVersion, "policyVersion"),
    route: input.route as ModelRoute,
  };
}

// Deliberately not a code-generation prompt -- ADR-0002's boundary applies
// to this reply as much as to the owner's own messages: the assistant must
// never claim an action was taken. Only an owner's later, explicit approval
// of a proposal (src/orchestrator/service.ts) can authorize anything.
const SYSTEM_PROMPT =
  "You are a collaborative interviewer helping the owner clarify what they " +
  "want to build, through conversation. Ask focused clarifying questions, " +
  "summarize what has been agreed so far, and never claim an action has " +
  "been taken or a file has been changed -- you have no execution " +
  "authority. Only the owner's later, explicit approval of a proposal can " +
  "authorize anything.";

// The real "assistant replies" half of CONTRACT-014 M2: routes one
// interview turn through AiGateway (taskClass "orchestration" -- Claude
// -first, matching "Claude is strategic orchestrator" everywhere else in
// this project, not the DeepSeek -> Codex -> Claude programming escalation
// chain, which is for code generation, not conversation) and appends the
// response as a real assistant message. Self-verifying: success is "the
// gateway call succeeded and the message was appended," no external
// verification step is meaningful for a conversational reply the way it is
// for a code patch.
export class ConversationReplyDriver implements OperationDriver {
  constructor(
    private readonly gateway: AiGateway,
    private readonly conversations: ConversationStore,
  ) {}

  async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
    const stored = parseConversationReplyTaskInput(input);
    const history = await this.conversations.messages(
      stored.projectId,
      stored.conversationId,
    );
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      // Same exclusion rule src/orchestrator/context.ts's compileContext()
      // already enforces (classification !== "secret") -- currently inert,
      // since nothing produces a "secret"-classified message today
      // (OwnerCommandService.sendMessage() always writes "internal"), but
      // this driver builds the gateway request independently of
      // compileContext rather than reusing it, so it needs its own copy of
      // the same rule to stay correct once anything upstream ever does
      // produce a secret-classified message.
      ...history
        .filter((message) => message.classification !== "secret")
        .map((message) => ({
          role:
            message.role === "owner"
              ? ("user" as const)
              : message.role === "assistant"
                ? ("assistant" as const)
                : ("system" as const),
          content: message.content,
        })),
    ];
    const result = await this.gateway.execute({
      idempotencyKey: stored.idempotencyKey,
      taskClass: "orchestration",
      attribution: stored.attribution,
      messages,
      maxOutputTokens: stored.maxOutputTokens,
      maxCostUsdMicros: stored.maxCostUsdMicros,
      policyVersion: stored.policyVersion,
      routeOverride: stored.route,
      signal,
    });
    const content = result.content.trim();
    const messageId = deterministicUuid(
      `conversation-reply:${stored.idempotencyKey}`,
    );
    const appended = await this.conversations.appendMessage(
      {
        id: messageId,
        conversationId: stored.conversationId,
        projectId: stored.projectId,
        role: "assistant",
        content,
        classification: "internal",
        contentSha256: sha256(content),
        createdAt: new Date(),
      },
      stored.expectedVersion,
      stored.idempotencyKey,
    );
    return { verified: true, messageId: appended.id };
  }
}
