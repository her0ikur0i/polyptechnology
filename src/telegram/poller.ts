import type { Pool } from "pg";
import type { TelegramRequester } from "./gateway.js";

// Where an update came from, extracted before anything in it is interpreted.
// A message and a button tap carry these in different places, which is exactly
// the kind of difference an identity check must not be careless about.
export interface UpdateOrigin {
  updateId: number;
  chatId?: string;
  userId?: string;
}

export interface TelegramUpdateHandler {
  handle(update: unknown, origin: UpdateOrigin): Promise<void>;
}

export interface UpdateOffsetStore {
  read(): Promise<number>;
  commit(offset: number): Promise<void>;
}

export class PostgresUpdateOffsetStore implements UpdateOffsetStore {
  constructor(private readonly pool: Pool) {}

  async read(): Promise<number> {
    const result = await this.pool.query(
      "SELECT update_offset FROM telegram_settings WHERE id = true",
    );
    const row = result.rows[0] as { update_offset: string } | undefined;
    return row === undefined ? 0 : Number(row.update_offset);
  }

  async commit(offset: number): Promise<void> {
    // GREATEST, not a plain assignment: the offset must never move backwards.
    // Two pollers briefly overlapping during a restart would otherwise let the
    // slower one rewind the queue and replay everything the faster one had
    // already handled.
    await this.pool.query(
      `UPDATE telegram_settings
          SET update_offset = GREATEST(update_offset, $1)
        WHERE id = true`,
      [Math.max(0, Math.trunc(offset))],
    );
  }
}

// Reads the identity fields Telegram puts in different places depending on the
// update type. Returns undefined for anything with no recognisable origin,
// which is refused rather than guessed at.
export function originOf(update: unknown): UpdateOrigin | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const record = update as Record<string, unknown>;
  const updateId = record.update_id;
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId))
    return undefined;

  const callback = record.callback_query as Record<string, unknown> | undefined;
  const message = (callback?.message ?? record.message) as
    Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const from = (callback?.from ?? message?.from) as
    Record<string, unknown> | undefined;

  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;

  return {
    updateId,
    ...(scalar(chat?.id) === undefined ? {} : { chatId: scalar(chat?.id)! }),
    ...(scalar(from?.id) === undefined ? {} : { userId: scalar(from?.id)! }),
  };
}

export interface PollerOptions {
  // Telegram holds the request open for this long when nothing is waiting.
  // Long polling is why inbound Telegram needs no public exposure at all.
  longPollSeconds?: number;
  maxUpdatesPerPoll?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
}

export interface PollOutcome {
  received: number;
  handled: number;
  refused: number;
  failed: number;
}

// Pulls updates from Telegram instead of being pushed to.
//
// The whole reason this exists rather than a webhook: a webhook needs a public
// HTTPS endpoint, and this deployment is loopback-only with public exposure
// deliberately deferred. getUpdates is an outbound call, so it needs no inbound
// port, no hostname, and no new trust boundary.
export class TelegramUpdatePoller {
  private backoff = 0;

  constructor(
    private readonly requester: TelegramRequester,
    private readonly offsets: UpdateOffsetStore,
    private readonly handler: TelegramUpdateHandler,
    private readonly authorizedChatIds: ReadonlyArray<string>,
    private readonly authorizedUserIds: ReadonlyArray<string>,
    private readonly options: PollerOptions = {},
  ) {}

  // Milliseconds the caller should wait before polling again. Zero while
  // healthy; grows on consecutive failures so a Telegram outage does not turn
  // into a request flood.
  get backoffMs(): number {
    return this.backoff;
  }

  private authorized(origin: UpdateOrigin): boolean {
    // Both must match. The channel is the credential here, so this runs before
    // any content is looked at -- an update from an unknown chat is never
    // parsed as a command, only counted and skipped.
    //
    // An empty allow-list refuses everything. It used to accept everything,
    // which read as "unconfigured means unrestricted" -- the exact inversion
    // CLAUDE.md's fail-closed invariant exists to prevent, and the same shape
    // as a route that serves anonymous callers because its auth config is
    // missing. Not reachable in production today, because sequence-main only
    // constructs a poller once both ids are configured. That is a guarantee
    // held by the caller, and M7 found this class is the security boundary for
    // a path that since Amendment 1 can change this repository as root. A
    // boundary should not depend on its caller remembering.
    const chatOk =
      origin.chatId !== undefined &&
      this.authorizedChatIds.includes(origin.chatId);
    const userOk =
      origin.userId !== undefined &&
      this.authorizedUserIds.includes(origin.userId);
    return chatOk && userOk;
  }

  async pollOnce(signal?: AbortSignal): Promise<PollOutcome> {
    const outcome: PollOutcome = {
      received: 0,
      handled: 0,
      refused: 0,
      failed: 0,
    };
    if (signal?.aborted) return outcome;

    let updates: unknown[];
    try {
      const offset = await this.offsets.read();
      const response = (await this.requester.call("getUpdates", {
        // Telegram treats `offset` as "acknowledge everything below this", so
        // the stored value is the last handled id and the request asks for the
        // next one.
        offset: offset === 0 ? undefined : offset + 1,
        limit: this.options.maxUpdatesPerPoll ?? 20,
        timeout: this.options.longPollSeconds ?? 25,
      })) as { ok?: boolean; result?: unknown[] };
      if (response?.ok !== true || !Array.isArray(response.result))
        throw new Error("getUpdates returned an unusable response");
      updates = response.result;
      this.backoff = 0;
    } catch {
      // Exponential, capped. A Telegram outage must degrade into quiet
      // retrying, never into a hot loop hammering an API that is already
      // struggling.
      const base = this.options.backoffMs ?? 1_000;
      const ceiling = this.options.maxBackoffMs ?? 60_000;
      this.backoff = Math.min(
        ceiling,
        this.backoff === 0 ? base : this.backoff * 2,
      );
      outcome.failed += 1;
      return outcome;
    }

    outcome.received = updates.length;
    let highest = 0;

    for (const update of updates) {
      const origin = originOf(update);
      if (origin === undefined) {
        // No recognisable update_id means it cannot be acknowledged either;
        // skipping without advancing would replay it forever, so it is counted
        // as refused and the batch's highest id still moves past it.
        outcome.refused += 1;
        continue;
      }
      highest = Math.max(highest, origin.updateId);

      if (!this.authorized(origin)) {
        outcome.refused += 1;
        continue;
      }

      try {
        await this.handler.handle(update, origin);
        outcome.handled += 1;
      } catch {
        // One bad update must not block the queue behind it. The offset still
        // advances, because retrying forever is how a single malformed message
        // stops every approval that comes after it. Approval tokens are
        // single-use, so a lost handling is safe in the direction that matters:
        // nothing is authorised twice.
        outcome.failed += 1;
      }
    }

    if (highest > 0) await this.offsets.commit(highest);
    return outcome;
  }
}
