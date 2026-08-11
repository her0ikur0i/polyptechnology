import { randomUUID } from "node:crypto";
import { deterministicUuid } from "../deterministic-id.js";
import { SYSTEM_PROMPT_FINGERPRINT } from "../operations/conversation-reply-driver.js";
import type { OwnerCommandService } from "../operations/owner-commands.js";
import type { ConversationStore } from "../orchestrator/types.js";
import type { TelegramRequester } from "./gateway.js";
import type { TelegramUpdateHandler, UpdateOrigin } from "./poller.js";

// Every Telegram message lands in one long-running conversation per chat rather
// than a new one each time, because that is what a chat *is*. The key is stable
// so startConversation()'s idempotency returns the same conversation and
// project on every call -- no extra table, and no risk of the id drifting from
// whatever the notifier is watching for.
// Includes the system prompt's fingerprint, so changing the prompt starts a
// new thread rather than inheriting a transcript that contradicts it.
export const telegramConversationKey = (chatId: string) =>
  deterministicUuid(
    `telegram:conversation:${SYSTEM_PROMPT_FINGERPRINT}:${chatId}`,
  );

// The actor recorded against everything that arrives this way. Distinct from a
// dashboard session on purpose: the audit trail should say where a message came
// from.
export const TELEGRAM_ACTOR = "owner-telegram";

export interface TelegramConversationDeps {
  owner: OwnerCommandService;
  conversations: ConversationStore;
  requester: TelegramRequester;
  csrfSecret: string;
}

// Turns a Telegram message into a real conversation turn.
//
// The authority boundary this must not bend: a message arriving here gains
// exactly the authority the same message typed into the dashboard would gain,
// and not one step more. It becomes an ordinary conversation message,
// classified and stored the same way, and the reply is queued as a background
// task through the same queueConversationReply() path.
//
// That authority is no longer "none". Since CONTRACT-017 Amendment 1 the
// assistant answering these messages has tools and a working directory, at the
// owner's instruction -- so the equivalence above is the whole guarantee, not a
// footnote to a stronger one. The factory's generation pipeline still requires
// the draft -> owner_review -> approved -> handed_off proposal gate; a chat
// cannot reach it.
//
// What follows from that: the poller's identity check is the security boundary
// for this path, and it runs before anything here is called.
//
// It routes through OwnerCommandService rather than the stores directly, so the
// same authorize() and the same validation run. Reaching past it "because we
// already checked identity in the poller" is how a second, weaker door gets
// built.
export class TelegramConversationHandler implements TelegramUpdateHandler {
  constructor(private readonly deps: TelegramConversationDeps) {}

  async handle(update: unknown, origin: UpdateOrigin): Promise<void> {
    const text = messageTextOf(update);
    if (text === undefined || origin.chatId === undefined) return;

    // Commands belong to M6's closed set. Handing "/status" to the interviewer
    // as conversation would be a confusing non-answer.
    if (text.startsWith("/")) return;

    const context = {
      authenticated: true as const,
      actorId: TELEGRAM_ACTOR,
      csrfToken: this.deps.csrfSecret,
    };
    const idempotencyKey = telegramConversationKey(origin.chatId);
    const projectId = deterministicUuid(
      `${TELEGRAM_ACTOR}:${idempotencyKey}:project`,
    );
    const conversationId = deterministicUuid(
      `${TELEGRAM_ACTOR}:${idempotencyKey}:conversation`,
    );

    // Look first, create only if absent.
    //
    // Calling startConversation() on every message looked idempotent because
    // the key is stable, and it is not: the store compares the whole *intent*,
    // and `occurredAt` changes every call. So the first Telegram message
    // created the conversation and every message after it was rejected with
    // "idempotency intent mismatch" before anything else could run -- no
    // reply, and no acknowledgement either, because the throw happened first.
    //
    // The ids are derived the same way OwnerCommandService derives them, which
    // is what makes the lookup possible without storing a mapping anywhere.
    let conversation = await this.deps.conversations.conversation(
      projectId,
      conversationId,
    );
    if (conversation === undefined) {
      await this.deps.owner.startConversation(context, {
        title: "Telegram",
        idempotencyKey,
        occurredAt: new Date().toISOString(),
      });
      conversation = await this.deps.conversations.conversation(
        projectId,
        conversationId,
      );
      if (conversation === undefined) return;
    }

    const started = { projectId, conversationId };

    await this.deps.owner.sendMessage(context, {
      conversationId: started.conversationId,
      projectId: started.projectId,
      content: text,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      expectedVersion: conversation.version,
    });

    // The reply is a background task and will not be immediate. Saying so beats
    // leaving the owner watching an empty chat wondering whether it arrived.
    await this.acknowledge(origin.chatId);
  }

  private async acknowledge(chatId: string) {
    try {
      await this.deps.requester.call("sendMessage", {
        chat_id: chatId,
        text: "⏳ Working on it…",
      });
    } catch (error) {
      // The message is already stored and the reply already queued. Failing to
      // say "working on it" must not undo that, but it is logged rather than
      // swallowed -- silence here is what hid the approval-button bug.
      console.error(
        JSON.stringify({
          event: "telegram.acknowledge.failed",
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}

// Plain text only. Photos, stickers and edits carry no text this system can
// treat as a conversation turn, and guessing at them would put unpredictable
// content into an authority-bearing channel.
function messageTextOf(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const message = (update as Record<string, unknown>).message as
    Record<string, unknown> | undefined;
  const text = message?.text;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  // The upper bound matches OwnerCommandService.sendMessage()'s own limit, so
  // an oversized message is refused here with a clear reason rather than
  // throwing out of the command service.
  return trimmed.length > 0 && trimmed.length <= 20_000 ? trimmed : undefined;
}
