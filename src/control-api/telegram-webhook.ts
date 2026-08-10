import { createHash, timingSafeEqual } from "node:crypto";
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
// Compared in constant time, matching requireCsrf in ./auth.ts rather than
// deviating from the pattern this codebase already established for exactly this
// kind of comparison. Raised by the CONTRACT-015 M8 review: a plain `!==`
// leaks position information through timing, and the throttle that made that
// impractical was itself bypassable until the same review's CRITICAL finding
// was fixed. Hashing first gives both sides a fixed, equal length, so
// timingSafeEqual cannot throw on a length mismatch and the comparison reveals
// nothing about the real secret's length either.
function matchesWebhookSecret(presented: string | undefined, secret: string) {
  if (presented === undefined) return false;
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(secret).digest(),
  );
}

export function requireTelegramWebhookSecret(secret: string) {
  return (req: Request, res: Response, next: () => void): void => {
    if (!matchesWebhookSecret(req.header(WEBHOOK_SECRET_HEADER), secret)) {
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
