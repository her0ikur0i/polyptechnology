import type { TelegramRequester } from "./gateway.js";

// A real animated loading icon. Telegram renders an animated GIF (sendAnimation)
// natively as a looping animation, so there is nothing to cycle on our side --
// send it once and delete it when the reply lands. A frame-cycling text
// fallback remains for when no animation URL is configured.
//
// The Lottie the owner originally wanted cannot be used directly: Lottiefiles
// blocks scripted downloads (403) and Telegram has no Lottie renderer. An
// animated GIF is the closest Telegram-native equivalent.
export const SPINNER_FRAMES = ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"] as const;

export const DEFAULT_SPINNER_ANIMATION_URL =
  "https://upload.wikimedia.org/wikipedia/commons/c/c7/Loading_2.gif";

interface ActiveSpinner {
  messageId: number;
  timer?: ReturnType<typeof setInterval>;
}

export class TelegramSpinner {
  private readonly active = new Map<string, ActiveSpinner>();

  constructor(
    private readonly requester: TelegramRequester,
    private readonly animationUrl?: string,
    private readonly frames: readonly string[] = SPINNER_FRAMES,
    private readonly intervalMs = 160,
  ) {}

  // Sends the loading animation and tracks it for stop(). Idempotent per chat:
  // starting a second spinner for the same chat stops the first one first.
  async start(chatId: string): Promise<void> {
    await this.stop(chatId);
    try {
      if (this.animationUrl !== undefined) {
        const sent = (await this.requester.call("sendAnimation", {
          chat_id: chatId,
          animation: this.animationUrl,
        })) as { result?: { message_id?: number } };
        const messageId = sent?.result?.message_id;
        if (messageId !== undefined) this.active.set(chatId, { messageId });
        return;
      }

      // No animation URL: fall back to cycling the text frames.
      const sent = (await this.requester.call("sendMessage", {
        chat_id: chatId,
        text: this.frames[0],
      })) as { result?: { message_id?: number } };
      const messageId = sent?.result?.message_id;
      if (messageId === undefined) return;
      let frame = 0;
      const timer = setInterval(() => {
        const current = this.active.get(chatId);
        if (current === undefined) return;
        frame = (frame + 1) % this.frames.length;
        void this.requester
          .call("editMessageText", {
            chat_id: chatId,
            message_id: current.messageId,
            text: this.frames[frame],
          })
          .catch(() => undefined);
      }, this.intervalMs);
      this.active.set(chatId, { messageId, timer });
    } catch {
      // The spinner is cosmetic; failing to show it must not fail the message.
    }
  }

  // Deletes the loading animation so the reply reads cleanly with nothing
  // lingering above it.
  async stop(chatId: string): Promise<void> {
    const entry = this.active.get(chatId);
    if (entry === undefined) return;
    this.active.delete(chatId);
    if (entry.timer !== undefined) clearInterval(entry.timer);
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
