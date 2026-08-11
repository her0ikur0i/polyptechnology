import { renderApproval } from "./report.js";
import type { ApprovalPrompt } from "./report.js";
export interface TelegramTransport {
  send(method: string, body: unknown): Promise<void>;
}

// Separate from TelegramTransport because sending and asking are genuinely
// different needs: everything that reports to the owner only sends, and giving
// those callers a method that returns provider data would invite them to start
// depending on it.
export interface TelegramRequester {
  call(method: string, body: unknown): Promise<unknown>;
}

export class TelegramHttpTransport
  implements TelegramTransport, TelegramRequester
{
  constructor(
    private readonly botToken: string,
    private readonly fetcher: typeof fetch = fetch,
    // Long polling deliberately holds a request open, so it cannot share the
    // 10 s ceiling that suits a fire-and-forget send.
    private readonly timeoutMs = 10_000,
  ) {}

  async send(method: string, body: unknown): Promise<void> {
    await this.call(method, body);
  }

  async call(method: string, body: unknown): Promise<unknown> {
    const response = await this.fetcher(
      `https://api.telegram.org/bot${this.botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok)
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    return response.json();
  }
}

export class TelegramApprovalGateway {
  constructor(
    private readonly transport: TelegramTransport,
    private readonly chatId: string,
  ) {}
  // `context` is optional so every existing caller keeps working, but supplying
  // it is the point: the message used to be a bare summary line and an ISO
  // timestamp, which is not enough to decide from on a phone. With cost and
  // remaining budget in the message, the owner can tap Approve without opening
  // the dashboard first -- which is the whole reason for asking here.
  async deliver(
    summary: string,
    token: string,
    expiresAt: Date,
    context?: Pick<
      ApprovalPrompt,
      "subject" | "detail" | "usage" | "budget" | "evidence"
    >,
  ): Promise<void> {
    const { text, reply_markup } = renderApproval({
      category: "approval",
      title: summary,
      token,
      expiresAt,
      ...(context ?? {}),
    });
    await this.transport.send("sendMessage", {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      reply_markup,
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
