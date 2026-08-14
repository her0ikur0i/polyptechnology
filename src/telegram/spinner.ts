import type { TelegramRequester } from "./gateway.js";

// A pure spinner icon, not animated text. Telegram has no native "spinner"
// chat action (typing/upload_* all show a text label), so the spinner is a
// real message whose frame is edited every intervalMs, then deleted when the
// reply lands -- a spinning icon that disappears the moment the answer is in.
export const SPINNER_FRAMES = [
  "⠁",
  "⠂",
  "⠄",
  "⡀",
  "⢀",
  "⠠",
  "⠐",
  "⠈",
] as const;

interface ActiveSpinner {
  messageId: number;
  frame: number;
  timer: ReturnType<typeof setInterval>;
}

export class TelegramSpinner {
  private readonly active = new Map<string, ActiveSpinner>();

  constructor(
    private readonly requester: TelegramRequester,
    private readonly frames: readonly string[] = SPINNER_FRAMES,
    private readonly intervalMs = 160,
  ) {}

  // Sends the spinner and starts cycling it. Idempotent per chat: starting a
  // second spinner for the same chat stops the first one first.
  async start(chatId: string): Promise<void> {
    await this.stop(chatId);
    try {
      const sent = (await this.requester.call("sendMessage", {
        chat_id: chatId,
        text: this.frames[0],
      })) as { result?: { message_id?: number } };
      const messageId = sent?.result?.message_id;
      if (messageId === undefined) return;
      const entry: ActiveSpinner = {
        messageId,
        frame: 0,
        timer: setInterval(() => {
          const current = this.active.get(chatId);
          if (current === undefined) return;
          current.frame = (current.frame + 1) % this.frames.length;
          void this.requester
            .call("editMessageText", {
              chat_id: chatId,
              message_id: current.messageId,
              text: this.frames[current.frame],
            })
            .catch(() => undefined);
        }, this.intervalMs),
      };
      this.active.set(chatId, entry);
    } catch {
      // The spinner is cosmetic; failing to show it must not fail the message.
    }
  }

  // Stops the animation and deletes the spinner message, so the reply reads
  // cleanly with nothing lingering above it.
  async stop(chatId: string): Promise<void> {
    const entry = this.active.get(chatId);
    if (entry === undefined) return;
    this.active.delete(chatId);
    clearInterval(entry.timer);
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
