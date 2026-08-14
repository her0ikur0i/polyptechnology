import type { TelegramRequester } from "./gateway.js";

// The loading indicator: an animated sticker the owner's Lottie was converted
// to. Telegram renders it natively as a looping animation; send it once and
// delete it when the reply lands.
interface ActiveSpinner {
  messageId: number;
}

export class TelegramSpinner {
  private readonly active = new Map<string, ActiveSpinner>();

  constructor(
    private readonly requester: TelegramRequester,
    private readonly stickerFileId: string,
  ) {}

  // Sends the loading sticker and tracks it for stop(). Idempotent per chat:
  // starting a second spinner for the same chat stops the first one first.
  async start(chatId: string): Promise<void> {
    await this.stop(chatId);
    try {
      const sent = (await this.requester.call("sendSticker", {
        chat_id: chatId,
        sticker: this.stickerFileId,
      })) as { result?: { message_id?: number } };
      const messageId = sent?.result?.message_id;
      if (messageId !== undefined) this.active.set(chatId, { messageId });
    } catch {
      // The spinner is cosmetic; failing to show it must not fail the message.
    }
  }

  // Deletes the loading sticker so the reply reads cleanly with nothing
  // lingering above it.
  async stop(chatId: string): Promise<void> {
    const entry = this.active.get(chatId);
    if (entry === undefined) return;
    this.active.delete(chatId);
    try {
      await this.requester.call("deleteMessage", {
        chat_id: chatId,
        message_id: entry.messageId,
      });
    } catch {
      // Already gone or edited elsewhere -- nothing to clean up.
    }
  }
}
