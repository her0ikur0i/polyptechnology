export interface TelegramTransport {
  send(method: string, body: unknown): Promise<void>;
}

export class TelegramHttpTransport implements TelegramTransport {
  constructor(
    private readonly botToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async send(method: string, body: unknown): Promise<void> {
    const response = await this.fetcher(
      `https://api.telegram.org/bot${this.botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  }
}

export class TelegramApprovalGateway {
  constructor(
    private readonly transport: TelegramTransport,
    private readonly chatId: string,
  ) {}
  async deliver(
    summary: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.transport.send("sendMessage", {
      chat_id: this.chatId,
      text: `${summary}\nExpires: ${expiresAt.toISOString()}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `approve:${token}` },
            { text: "Deny", callback_data: `deny:${token}` },
          ],
        ],
      },
    });
  }
}

export function parseTelegramCallback(update: unknown):
  | {
      decision: "approved" | "denied";
      token: string;
      chatId: string;
      userId: string;
    }
  | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const query = (update as Record<string, unknown>).callback_query;
  if (typeof query !== "object" || query === null) return undefined;
  const q = query as Record<string, unknown>;
  const message = q.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const from = q.from as Record<string, unknown> | undefined;
  if (
    typeof q.data !== "string" ||
    (typeof chat?.id !== "string" && typeof chat?.id !== "number") ||
    (typeof from?.id !== "string" && typeof from?.id !== "number")
  )
    return undefined;
  const match = /^(approve|deny):([A-Za-z0-9_-]{43})$/.exec(q.data);
  if (match === null) return undefined;
  return {
    decision: match[1] === "approve" ? "approved" : "denied",
    token: match[2]!,
    chatId: String(chat.id),
    userId: String(from.id),
  };
}

export interface TelegramDecisionService {
  decide(
    token: string,
    decision: "approved" | "denied",
    chatId: string,
    userId: string,
    now?: Date,
  ): Promise<{ outcome: string }>;
}

export async function handleTelegramCallback(
  update: unknown,
  service: TelegramDecisionService,
  now = new Date(),
): Promise<{ outcome: string }> {
  const callback = parseTelegramCallback(update);
  if (callback === undefined) return { outcome: "invalid" };
  return service.decide(
    callback.token,
    callback.decision,
    callback.chatId,
    callback.userId,
    now,
  );
}
