import type { TelegramRequester } from "./gateway.js";
import type { TelegramUpdateHandler, UpdateOrigin } from "./poller.js";

// Answers "pick:*" callback buttons (sample choosers) so they don't fall
// through to the approval handler and show "this approval no longer exists".
// The choice is logged for the operator; nothing is persisted by this handler.
function pickOf(
  update: unknown,
): { callbackQueryId: string; choice: string } | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const query = (update as Record<string, unknown>).callback_query as
    Record<string, unknown> | undefined;
  if (
    query === undefined ||
    typeof query.id !== "string" ||
    typeof query.data !== "string"
  )
    return undefined;
  if (!query.data.startsWith("pick:")) return undefined;
  return { callbackQueryId: query.id, choice: query.data.slice(5) };
}

export class TelegramPickHandler implements TelegramUpdateHandler {
  constructor(private readonly requester: TelegramRequester) {}

  async handle(update: unknown, _origin: UpdateOrigin): Promise<void> {
    const pick = pickOf(update);
    if (pick === undefined) return;
    console.log(
      JSON.stringify({ event: "telegram.pick", choice: pick.choice }),
    );
    try {
      // Answer so the button stops spinning; the toast tells the owner it was
      // seen rather than silently doing nothing.
      await this.requester.call("answerCallbackQuery", {
        callback_query_id: pick.callbackQueryId,
        text: `Pilihan dicatat: ${pick.choice}`,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "telegram.pick.failed",
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}
