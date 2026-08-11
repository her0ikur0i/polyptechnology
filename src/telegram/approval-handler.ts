import { handleTelegramCallback, parseTelegramCallback } from "./gateway.js";
import type { TelegramDecisionService, TelegramRequester } from "./gateway.js";
import type { TelegramUpdateHandler, UpdateOrigin } from "./poller.js";

// Presentation-only fields. Deliberately separate from parseTelegramCallback(),
// which extracts what the *authorization* decision needs and nothing else --
// mixing "which message do I edit" into that function would put cosmetic
// concerns inside a security boundary.
interface CallbackSurface {
  callbackQueryId: string;
  chatId?: string | number;
  messageId?: number;
}

function surfaceOf(update: unknown): CallbackSurface | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const query = (update as Record<string, unknown>).callback_query as
    Record<string, unknown> | undefined;
  if (query === undefined || typeof query.id !== "string") return undefined;
  const message = query.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  return {
    callbackQueryId: query.id,
    ...(typeof chat?.id === "string" || typeof chat?.id === "number"
      ? { chatId: chat.id as string | number }
      : {}),
    ...(typeof message?.message_id === "number"
      ? { messageId: message.message_id }
      : {}),
  };
}

// The outcome vocabulary ApprovalRepository.decide() actually returns.
//
// An earlier version of this file invented "approved" / "denied" /
// "already_decided" and checked against those. None of them are ever produced,
// so the settle step never ran and the buttons stayed live after a decision --
// which the owner found immediately by tapping Approve twice. The unit tests
// had passed because their fake decision service returned the same invented
// strings: the test agreed with the assumption rather than with the system.
//
// Read from src/approvals/postgres-repository.ts. Do not add an entry here
// without finding it there first.
const DECIDED = "decided";

const OUTCOME_TEXT: Record<string, string> = {
  replayed: "⚠️ Already decided",
  expired: "⏱ This approval has expired",
  unauthorized: "🚫 Not authorised",
  invalid: "⚠️ This approval no longer exists",
};

// Turns a button tap into a real approval decision.
//
// The decision itself goes through the same TelegramDecisionService the webhook
// route uses. That is the point: two ways to approve something is how they
// drift, and the one that drifts is the one nobody is testing. This class adds
// only what a tap needs that an HTTP POST does not -- answering the callback so
// the button stops spinning, and rewriting the message so a decided approval
// cannot be tapped again.
export class TelegramApprovalUpdateHandler implements TelegramUpdateHandler {
  constructor(
    private readonly requester: TelegramRequester,
    private readonly decisions: TelegramDecisionService,
  ) {}

  async handle(update: unknown, _origin: UpdateOrigin): Promise<void> {
    const surface = surfaceOf(update);
    // Not a button tap. Messages and commands belong to other handlers, and
    // silently ignoring them here is correct rather than an error.
    if (surface === undefined) return;

    // parseTelegramCallback() refuses anything whose data is not
    // approve|deny plus a 43-character token, so a crafted callback cannot
    // reach the decision service at all.
    const parsed = parseTelegramCallback(update);
    const outcome =
      parsed === undefined
        ? "invalid"
        : (await handleTelegramCallback(update, this.decisions)).outcome;

    // "decided" does not say *which* way. The button the owner pressed does,
    // and parseTelegramCallback already validated it.
    const settled =
      outcome === DECIDED
        ? parsed?.decision === "denied"
          ? "❌ Denied"
          : "✅ Approved"
        : undefined;

    // Answer first, and never let a failure here hide the decision that was
    // already recorded. Telegram leaves the button spinning for ~30s if this
    // is skipped, which reads as "nothing happened" for something that did.
    await this.answer(
      surface.callbackQueryId,
      settled ?? OUTCOME_TEXT[outcome] ?? `Recorded: ${outcome}`,
      settled === undefined,
    );

    if (settled !== undefined) await this.settle(surface, settled);
  }

  private async answer(
    callbackQueryId: string,
    text: string,
    showAlert: boolean,
  ) {
    try {
      await this.requester.call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
        // A refusal deserves a dialog the owner has to dismiss; a successful
        // decision only needs the toast, because the message itself changes.
        show_alert: showAlert,
      });
    } catch (error) {
      // The decision is already durable, so this must not throw into the
      // poller. But it is logged rather than swallowed in silence: the last
      // time this class failed quietly, live buttons stayed tappable and
      // nothing anywhere said so.
      console.error(
        JSON.stringify({
          event: "telegram.answer.failed",
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  // Strips the buttons and appends the outcome, so a decided approval stops
  // looking actionable. Without this the owner sees the same two buttons after
  // deciding, and a second tap answers "already decided" -- which works, but
  // reads as the system having ignored them.
  private async settle(surface: CallbackSurface, settledText: string) {
    if (surface.chatId === undefined || surface.messageId === undefined) return;
    try {
      await this.requester.call("editMessageReplyMarkup", {
        chat_id: surface.chatId,
        message_id: surface.messageId,
        reply_markup: { inline_keyboard: [] },
      });
      await this.requester.call("sendMessage", {
        chat_id: surface.chatId,
        reply_to_message_id: surface.messageId,
        text: settledText,
      });
    } catch (error) {
      // Same reasoning as answer(): the record is what matters. Logged, not
      // swallowed -- a silent failure here is exactly what left live buttons on
      // an already-decided approval.
      console.error(
        JSON.stringify({
          event: "telegram.settle.failed",
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}
