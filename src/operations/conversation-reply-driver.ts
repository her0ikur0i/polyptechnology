import { createHash } from "node:crypto";
import type { OperationDriver } from "./execution-supervisor.js";
import type { AiGateway } from "../gateway/gateway.js";
import {
  CoalescingChunkWriter,
  type ReplyChunkSink,
} from "../orchestrator/reply-chunks.js";

import type { ConversationStore } from "../orchestrator/types.js";
import type { GatewayAttribution, ModelRoute } from "../gateway/types.js";
import { deterministicUuid } from "../deterministic-id.js";

// Storage this driver needs: the sink CoalescingChunkWriter writes through,
// plus cleanup once the reply is a real message.
export interface ReplyChunkStore extends ReplyChunkSink {
  clear(taskId: string): Promise<void>;
}

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
  // Four fields were validated and four were blindly cast until the
  // CONTRACT-016 M4 review pointed out the asymmetry. attribution.taskId in
  // particular is now the key this driver writes and clears progress rows by,
  // and AiGateway.validate() only rejects *empty strings* in attribution, not
  // missing keys -- so an undefined taskId would have reached SQL as NULL and
  // failed silently rather than loudly. Currently unreachable, because
  // queueConversationReply() is the only producer and always builds a
  // well-formed object; validated anyway so it fails closed with a clear
  // message if that ever stops being true.
  const attribution = input.attribution;
  if (typeof attribution !== "object" || attribution === null)
    throw new Error("conversation_reply input: attribution must be an object");
  for (const field of [
    "projectId",
    "contractId",
    "milestoneId",
    "taskId",
    "agentId",
  ] as const)
    assertString(
      (attribution as Record<string, unknown>)[field],
      `attribution.${field}`,
    );
  if (typeof input.route !== "object" || input.route === null)
    throw new Error("conversation_reply input: route must be an object");
  for (const field of ["maxOutputTokens", "maxCostUsdMicros"] as const)
    if (!Number.isSafeInteger(input[field]) || (input[field] as number) <= 0)
      throw new Error(
        `conversation_reply input: ${field} must be a positive integer`,
      );

  return {
    conversationId: assertString(input.conversationId, "conversationId"),
    projectId: assertString(input.projectId, "projectId"),
    expectedVersion: input.expectedVersion as number,
    idempotencyKey: assertString(input.idempotencyKey, "idempotencyKey"),
    attribution: attribution as GatewayAttribution,
    maxOutputTokens: input.maxOutputTokens as number,
    maxCostUsdMicros: input.maxCostUsdMicros as number,
    policyVersion: assertString(input.policyVersion, "policyVersion"),
    route: input.route as ModelRoute,
  };
}

// The owner overruled the interviewer-only posture on 2026-08-10, with the
// concern stated and understood: this is their own controlled single-owner
// machine, and they want the assistant to be genuinely capable from their
// phone rather than a suggestion box.
//
// What that means concretely, recorded so nobody later mistakes it for drift:
// the assistant has real tools and a real working directory, so it can read
// and change this repository. ADR-0002's proposal gate still governs the
// *factory's* generation pipeline; it no longer governs this conversation.
// That is a deliberate, owner-authorised reduction in scope for that boundary,
// not an oversight.
export const SYSTEM_PROMPT =
  "You are the owner's AI colleague for the Polyp AI Factory, reachable from " +
  "Telegram and from the dashboard. Take whichever role the moment needs -- " +
  "engineer, architect, reviewer, planner -- but your first job is always to " +
  "be sure you understand what the owner actually wants.\n\n" +
  "Judge intent before acting. When a request is clear, do it and report what " +
  "you did. When it is ambiguous, or when the obvious reading would be " +
  "expensive or hard to undo, ask one focused question first. Make clear " +
  "which of the two you are doing, so the owner is never left guessing " +
  "whether you understood them.\n\n" +
  "You have real tools and run inside the project repository: read files, run " +
  "commands, change code. Prefer checking the repository over speculating, " +
  "and never present a guess as a finding -- if you did not verify it, say " +
  "so. When you change something, say exactly what changed.\n\n" +
  "Once intent is settled, follow through into something concrete: a plan, a " +
  "stack decision, a document, a change. For work the factory itself should " +
  "build, that means a proposal the owner approves -- not something you do by " +
  "hand.\n\n" +
  "Answers are usually read on a phone. Be concise and lead with the answer.";

// A short fingerprint of the prompt above.
//
// The prompt is not the only thing the model reads: the whole conversation
// history is replayed into every request, including the assistant's own past
// turns. When this prompt changed from "you are an interviewer with no
// execution authority" to a capable assistant, the old thread still contained
// replies saying "I cannot read files" -- and the model stayed consistent with
// its own transcript, answering a question correctly and then recanting it two
// turns later.
//
// Deriving the fingerprint from the prompt text means any future change to it
// starts a fresh conversation automatically, instead of depending on someone
// remembering that stale turns now contradict the new instructions.
export const SYSTEM_PROMPT_FINGERPRINT = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 12);

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
  // chunks is optional so the driver keeps working with no streaming storage
  // at all -- the reply still completes, the owner simply sees it arrive whole
  // instead of progressively. Streaming must never be load-bearing for
  // correctness.
  constructor(
    private readonly gateway: AiGateway,
    private readonly conversations: ConversationStore,
    private readonly chunks?: ReplyChunkStore,
  ) {}

  async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
    const stored = parseConversationReplyTaskInput(input);
    const history = await this.conversations.messages(
      stored.projectId,
      stored.conversationId,
    );
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      // The assistant's own conversation id, plus the one action that turns a
      // conversation into factory work. Injected per request rather than baked
      // into SYSTEM_PROMPT so the prompt fingerprint -- and therefore the
      // thread -- does not change every time a conversation does.
      {
        role: "system" as const,
        content:
          `You are in conversation ${stored.conversationId}.\n` +
          "When the owner has settled on something the factory should build, " +
          "draft it as a proposal for their approval by running:\n" +
          `  node --import tsx scripts/propose.ts ${stored.conversationId}\n` +
          "That records a proposal awaiting their decision. It does not " +
          "authorise anything: nothing is translated into a blueprint or " +
          "generated until they approve. Prefer this over building the " +
          "owner's product by hand -- constructing it yourself bypasses the " +
          "factory that exists to construct it.",
      },
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
    // Progress fragments cross a process boundary: this driver runs inside
    // polyp-sequence.service while the SSE route that shows them is held by the
    // Control API. Writer is created only when chunk storage exists, so a
    // deployment without it degrades to a non-streaming reply rather than
    // failing.
    // Wipe any progress a previous attempt of THIS SAME task left behind.
    //
    // A retried task keeps its task_id (src/work/postgres-repository.ts moves
    // the same row through retry_wait and re-leases it), but each attempt
    // builds a fresh writer whose ordinals restart at 1. Without this, the
    // unique constraint's ON CONFLICT DO NOTHING preserves the dead attempt's
    // fragments and silently drops the live one's at every colliding ordinal,
    // so a reader tailing the stream sees a splice of stale text followed by
    // the real tail. Reproduced by the CONTRACT-016 M4 independent review;
    // harmless today only because nothing reads chunks yet, which is exactly
    // why it had to be fixed before CONTRACT-018 wires up a reader.
    //
    // Best-effort and swallowed, same posture as the post-success clear: a
    // failure to tidy progress must never cost the owner an answer.
    try {
      await this.chunks?.clear(stored.attribution.taskId);
    } catch {
      // A stale-fragment splice in the progress view is bad; failing the reply
      // outright to avoid it would be worse.
    }

    const writer =
      this.chunks === undefined
        ? undefined
        : new CoalescingChunkWriter(
            this.chunks,
            stored.attribution.taskId,
            stored.conversationId,
          );

    let result;
    try {
      result = await this.gateway.execute({
        idempotencyKey: stored.idempotencyKey,
        taskClass: "orchestration",
        attribution: stored.attribution,
        messages,
        maxOutputTokens: stored.maxOutputTokens,
        maxCostUsdMicros: stored.maxCostUsdMicros,
        policyVersion: stored.policyVersion,
        routeOverride: stored.route,
        signal,
        ...(writer === undefined
          ? {}
          : { onDelta: (fragment: string) => writer.push(fragment) }),
      });
    } finally {
      // Always, including on failure: a stream that died still queued writes,
      // and leaving them pending would strand fragments in memory and keep the
      // serialized write chain alive after the task has moved on.
      await writer?.flush();
    }

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

    // The answer is now a real message, so the progress rows have no further
    // purpose. Deliberately outside the append: a cleanup failure must never be
    // able to undo a completed reply, so this is best-effort and its failure is
    // swallowed on purpose rather than by omission.
    try {
      await this.chunks?.clear(stored.attribution.taskId);
    } catch {
      // Left behind until this task is attempted again, which clears it first.
      // There is deliberately no age-based sweep yet -- an earlier version of
      // this comment claimed one existed and the M4 review found it did not.
      // CONTRACT-018 adds it alongside the reader that makes these rows matter.
    }

    return { verified: true, messageId: appended.id };
  }
}
