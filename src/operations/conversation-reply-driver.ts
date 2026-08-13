import { createHash } from "node:crypto";
import type { OperationDriver } from "./execution-supervisor.js";
import type { AiGateway } from "../gateway/gateway.js";
import {
  CoalescingChunkWriter,
  type ReplyChunkSink,
} from "../orchestrator/reply-chunks.js";

import type { ConversationStore } from "../orchestrator/types.js";
import type { OperationContext } from "./execution-supervisor.js";
import type { ProviderSessionStore } from "../orchestrator/provider-sessions.js";
import type { GatewayAttribution, ModelRoute } from "../gateway/types.js";
import { deterministicUuid } from "../deterministic-id.js";
import { modelRoutes } from "../gateway/model-policy.js";

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
  // Deprecated. Older queued specs include a route snapshot. The driver no
  // longer uses it as a routeOverride because policy changes made those
  // snapshots fail with "route override is outside policy" before a provider
  // call. Kept only so old specs parse while they drain.
  route?: ModelRoute;
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
  const route =
    typeof input.route === "object" && input.route !== null
      ? (input.route as ModelRoute)
      : undefined;
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
    ...(route === undefined ? {} : { route }),
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
  "Answers are usually read on a phone. Be concise and lead with the answer.\n\n" +
  // Precedence, stated explicitly, because a cold start still replays history.
  //
  // A resumed turn sends only the new message, so nothing old can argue with
  // these instructions. But when no session exists the whole thread goes, and
  // it may contain assistant turns written under a previous prompt -- which is
  // exactly how this assistant once answered "17 contracts" correctly and then
  // denied being able to read files. These instructions are current; anything
  // earlier in the conversation that contradicts them is not.
  "These instructions are current and take precedence. If anything earlier in " +
  "this conversation contradicts them -- including your own previous replies " +
  "about what you can and cannot do -- treat this message as correct and " +
  "those as out of date.";

// The real "assistant replies" half of CONTRACT-014 M2: routes one interview
// turn through AiGateway using the current orchestration policy and appends the
// response as a real assistant message. Self-verifying: success is "the gateway
// call succeeded and the message was appended," no external verification step
// is meaningful for a conversational reply the way it is for a code patch.
export class ConversationReplyDriver implements OperationDriver {
  // chunks is optional so the driver keeps working with no streaming storage
  // at all -- the reply still completes, the owner simply sees it arrive whole
  // instead of progressively. Streaming must never be load-bearing for
  // correctness.
  // sessions is optional for the same reason chunks is: without it every turn
  // replays the transcript, which is precisely how this driver behaved before
  // CONTRACT-017A. Continuity is an optimisation, never a correctness
  // requirement.
  constructor(
    private readonly gateway: AiGateway,
    private readonly conversations: ConversationStore,
    private readonly chunks?: ReplyChunkStore,
    private readonly sessions?: ProviderSessionStore,
  ) {}

  async execute(
    input: unknown,
    signal: AbortSignal,
    context?: OperationContext,
  ): Promise<unknown> {
    const stored = parseConversationReplyTaskInput(input);

    // One ledger entry per attempt.
    //
    // The key in the spec is fixed for the life of the task -- the spec row is
    // immutable by trigger -- while the request hash covers the transcript,
    // which grows between attempts. The ledger saw the same key with a
    // different intent and correctly refused it, so every retry of a
    // conversation whose thread had moved on died with
    // `idempotency intent mismatch` in about 25 milliseconds, before reserving
    // budget and before reaching a provider. Retry was futile for exactly the
    // tasks most likely to need it.
    //
    // Attempt 1 keeps the original key so nothing already in the ledger is
    // orphaned, and so a genuine duplicate delivery of the first attempt still
    // deduplicates the way idempotency is supposed to.
    const attemptOrdinal = context?.attemptOrdinal ?? 1;
    const idempotencyKey =
      attemptOrdinal <= 1
        ? stored.idempotencyKey
        : `${stored.idempotencyKey}#${attemptOrdinal}`;
    const history = await this.conversations.messages(
      stored.projectId,
      stored.conversationId,
    );
    // Resume the provider's own session when there is one, and send only the
    // new turn. Otherwise send everything, which is what every turn did before
    // this existed.
    //
    // Whole-transcript replay is why a long thread grew more expensive with
    // every message, why cache reads ran to six figures of tokens per turn,
    // and why a long enough thread would eventually be refused outright. It is
    // also why a *retry* could never succeed: the transcript grows between
    // attempts, so the request hash changed and the ledger refused it.
    const currentPrimaryRoute = modelRoutes("orchestration")[0];
    if (currentPrimaryRoute === undefined)
      throw new Error("no static orchestration route");
    const resumeSessionId = await this.sessions?.find(
      stored.conversationId,
      currentPrimaryRoute.provider,
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
      // On a resume the provider already holds everything before the last
      // owner message, so sending it again would defeat the point. On a cold
      // start the whole thread goes, exactly as before.
      ...(resumeSessionId === undefined ? history : history.slice(-1))
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
        idempotencyKey,
        taskClass: "orchestration",
        attribution: stored.attribution,
        messages,
        maxOutputTokens: stored.maxOutputTokens,
        maxCostUsdMicros: stored.maxCostUsdMicros,
        policyVersion: stored.policyVersion,
        signal,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        ...(writer === undefined
          ? {}
          : { onDelta: (fragment: string) => writer.push(fragment) }),
      });
    } catch (error) {
      // A resume that failed may mean the provider has forgotten the session:
      // they expire, and nothing tells us when. Drop the row so the task's own
      // retry replays the transcript from scratch instead of asking again for
      // a session that no longer exists.
      //
      // Deliberately not retried in-process. The work engine already knows how
      // to retry with backoff, and a second gateway call inside one attempt
      // would need its own ledger identity and its own budget reservation --
      // machinery that exists one layer up and is tested there. The cost of
      // deferring is one silent retry cycle; the owner sees the answer a
      // moment later, not a failure.
      //
      // Unconditional on the resume path: the alternative is pattern-matching
      // provider error strings to decide whether a session is dead, which is
      // exactly the kind of guess that produced "provider returned unusable
      // output" for failures that never reached a provider.
      if (resumeSessionId !== undefined)
        await this.sessions?.forget(
          stored.conversationId,
          currentPrimaryRoute.provider,
        );
      throw error;
    } finally {
      // Always, including on failure: a stream that died still queued writes,
      // and leaving them pending would strand fragments in memory and keep the
      // serialized write chain alive after the task has moved on.
      await writer?.flush();
    }

    // The provider's session id for this exchange. It has always been
    // returned and always been stored on the attempt row as
    // providerRequestId; what was missing was holding it against the
    // conversation so the next turn can resume it.
    if (result.attempt.providerRequestId !== undefined)
      await this.sessions?.remember(
        stored.conversationId,
        result.attempt.route.provider,
        result.attempt.providerRequestId,
      );

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
