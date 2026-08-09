import type { Request, Response } from "express";
import { PostgresApprovalRepository } from "../approvals/postgres-repository.js";
import { hashApprovalToken } from "../approvals/token.js";
import { handleTelegramCallback } from "../telegram/gateway.js";
import type { TelegramDecisionService } from "../telegram/gateway.js";
import type { Pool } from "pg";

const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

// docs/operations/telegram-approvals.md: "configure an authenticated HTTPS
// webhook with secret-header validation" -- this is Telegram's own
// documented mechanism (setWebhook's secret_token parameter, echoed back on
// every call as X-Telegram-Bot-Api-Secret-Token), not a bespoke scheme.
// Absence/mismatch fails closed with no callback processed, matching the
// same doc's "Telegram outage never grants authority" posture.
export function requireTelegramWebhookSecret(secret: string) {
  return (req: Request, res: Response, next: () => void): void => {
    if (req.header(WEBHOOK_SECRET_HEADER) !== secret) {
      res.status(401).json({ error: "invalid webhook secret" });
      return;
    }
    next();
  };
}

class PostgresTelegramDecisionService implements TelegramDecisionService {
  constructor(
    private readonly repository: PostgresApprovalRepository,
    private readonly authorizedChatId: string,
    private readonly authorizedUserId: string,
  ) {}

  async decide(
    token: string,
    decision: "approved" | "denied",
    chatId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<{ outcome: string }> {
    const result = await this.repository.decide(
      { tokenHash: hashApprovalToken(token), decision, chatId, userId, now },
      this.authorizedChatId,
      this.authorizedUserId,
    );
    return { outcome: result.outcome };
  }
}

// Wires src/telegram/gateway.ts's parseTelegramCallback/handleTelegramCallback
// (built in an earlier contract, never reachable from any real route until
// now) to a real Express handler. The single authorized chat/user ID pair
// comes from config (TELEGRAM_CHAT_ID/TELEGRAM_USER_ID) -- the source of
// truth ApprovalRepository.decide() already checks against -- not the
// dashboard-configurable authorizedChatIds/authorizedUserIds arrays
// (src/control-api/telegram-settings-store.ts), which serve display/future
// masking purposes, not this authorization decision.
export function createTelegramWebhookHandler(
  pool: Pool,
  authorizedChatId: string,
  authorizedUserId: string,
) {
  const service = new PostgresTelegramDecisionService(
    new PostgresApprovalRepository(pool),
    authorizedChatId,
    authorizedUserId,
  );
  return async (req: Request, res: Response): Promise<void> => {
    const result = await handleTelegramCallback(req.body, service);
    res.json(result);
  };
}
