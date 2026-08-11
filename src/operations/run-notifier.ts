import type { Pool } from "pg";
import { renderReport, splitForTelegram } from "../telegram/report.js";
import type {
  BudgetLine,
  ReportCategory,
  UsageLine,
} from "../telegram/report.js";
import type { TelegramTransport } from "../telegram/gateway.js";

export interface TaskFinished {
  taskId: string;
  attemptOrdinal: number;
  outcome: string;
  reason?: string;
  driver?: string;
}

// Deliberately narrow. The supervisor should not know that Telegram exists, and
// swapping or silencing the channel must not require touching the execution
// path.
export interface RunNotifier {
  taskFinished(event: TaskFinished): Promise<void>;
}

// Reads what a task actually cost, from records the gateway already writes.
// Attribution is jsonb on the attempt row, so a task's spend is the sum across
// every attempt it made -- including the ones that failed, which is the number
// that matters when the report is about a failure.
export class PostgresRunFacts {
  constructor(private readonly pool: Pool) {}

  async usageFor(
    taskId: string,
  ): Promise<{ usage?: UsageLine; budget?: BudgetLine }> {
    const attempts = await this.pool.query(
      `SELECT a.provider_id,
              COALESCE(a.resolved_model_id, a.requested_model_id) AS model_id,
              a.budget_scope_id,
              COALESCE(SUM(u.input_tokens), 0)     AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0)    AS output_tokens,
              COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(u.cost_usd_micros), 0)  AS cost_usd_micros
         FROM ai_gateway_attempts a
         LEFT JOIN ai_usage_events u ON u.attempt_id = a.id
        WHERE a.attribution->>'taskId' = $1
        GROUP BY a.provider_id, model_id, a.budget_scope_id
        ORDER BY SUM(u.cost_usd_micros) DESC NULLS LAST
        LIMIT 1`,
      [taskId],
    );
    const row = attempts.rows[0] as
      | {
          provider_id: string;
          model_id: string;
          budget_scope_id: string;
          input_tokens: string;
          output_tokens: string;
          cache_read_tokens: string;
          cost_usd_micros: string;
        }
      | undefined;
    if (row === undefined) return {};

    const usage: UsageLine = {
      provider: row.provider_id,
      model: row.model_id,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      costUsdMicros: Number(row.cost_usd_micros),
    };

    const budget = await this.pool.query(
      "SELECT spent_usd_micros, max_cost_usd_micros FROM ai_budget_accounts WHERE scope_id = $1",
      [row.budget_scope_id],
    );
    const account = budget.rows[0] as
      { spent_usd_micros: string; max_cost_usd_micros: string } | undefined;

    return account === undefined
      ? { usage }
      : {
          usage,
          budget: {
            spentUsdMicros: Number(account.spent_usd_micros),
            limitUsdMicros: Number(account.max_cost_usd_micros),
          },
        };
  }

  // The assistant's answer for a finished conversation_reply task, but only
  // when it belongs to the conversation Telegram owns.
  //
  // Scoped that way on purpose: every dashboard conversation also produces
  // conversation_reply tasks, and echoing those into the chat would turn the
  // owner's phone into a firehose of replies to questions they asked somewhere
  // else.
  async replyFor(
    taskId: string,
    conversationId: string,
  ): Promise<string | undefined> {
    const spec = await this.pool.query(
      `SELECT input->>'conversationId' AS conversation_id
         FROM operation_task_specs
        WHERE task_id = $1 AND driver = 'conversation_reply'`,
      [taskId],
    );
    const row = spec.rows[0] as { conversation_id: string } | undefined;
    if (row === undefined || row.conversation_id !== conversationId)
      return undefined;

    const message = await this.pool.query(
      `SELECT content FROM conversation_messages
        WHERE conversation_id = $1 AND role = 'assistant'
        ORDER BY ordinal DESC LIMIT 1`,
      [conversationId],
    );
    return (message.rows[0] as { content: string } | undefined)?.content;
  }
}

const CATEGORY_FOR: Record<string, ReportCategory> = {
  succeeded: "success",
  failed: "failure",
  cancelled: "stopped",
  retry_wait: "warning",
};

// Failure reasons the work engine produces, phrased as something a person
// woken by their phone can act on rather than as an enum value.
const REASON_TEXT: Record<string, string> = {
  policy: "refused by routing policy",
  verification: "verification gate failed",
  worker: "worker or transport failure",
  invalid_output: "provider returned unusable output",
};

export class TelegramRunNotifier implements RunNotifier {
  constructor(
    private readonly transport: TelegramTransport,
    private readonly chatId: string,
    private readonly facts?: PostgresRunFacts,
    // When set, a finished conversation_reply for this conversation delivers
    // the assistant's answer to the chat instead of a "Task succeeded" report.
    // A run report is the right thing for work; for a conversation the answer
    // *is* the report, and prefixing it with task machinery would bury it.
    private readonly telegramConversationId?: string,
  ) {}

  // Exercises the HTTP stack once at startup so a broken transport surfaces at
  // boot instead of at the end of the first successful task.
  //
  // This exists because of a real incident. Under `--jitless` (added to satisfy
  // MemoryDenyWriteExecute), the first fetch() made Node's bundled undici
  // lazily compile its llhttp WebAssembly parser, which --jitless had disabled.
  // The ReferenceError was thrown during *synchronous module initialisation*
  // inside Node internals, so taskFinished()'s try/catch could not contain it:
  // a catch around an await does not catch a throw that happens while a module
  // is being required. The supervisor died, and the notification for the first
  // real task this system ever executed was lost.
  //
  // The root cause is fixed, but "the notifier can never take down the
  // supervisor" was an overclaim. Failing loudly at boot is the honest way to
  // keep the promise.
  async warmUp(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.transport.send("getMe", {});
      return { ok: true, detail: "notification transport reachable" };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "unknown failure",
      };
    }
  }

  async taskFinished(event: TaskFinished): Promise<void> {
    // Reporting must never be able to change the outcome of the work it
    // reports on. Every failure here is swallowed: a Telegram outage, a
    // malformed chat id, a rate limit -- none of them are reasons to fail a
    // task that already succeeded, or to mask one that already failed.
    try {
      const category = CATEGORY_FOR[event.outcome] ?? "warning";
      const facts =
        this.facts === undefined
          ? {}
          : await this.facts.usageFor(event.taskId).catch(() => ({}));

      // A conversation the owner is having in Telegram gets its answer back,
      // not a task report about it.
      if (
        category === "success" &&
        this.facts !== undefined &&
        this.telegramConversationId !== undefined
      ) {
        const reply = await this.facts
          .replyFor(event.taskId, this.telegramConversationId)
          .catch(() => undefined);
        if (reply !== undefined) {
          // Split, not truncated. Cutting at 4,000 characters loses the end of
          // an answer, which is usually where it concludes something.
          for (const part of splitForTelegram(reply))
            await this.transport.send("sendMessage", {
              chat_id: this.chatId,
              // Plain text, no parse_mode: this is model output, and asking
              // Telegram to parse it as HTML would let a stray "<" from a code
              // sample fail the send -- losing the answer to a formatting rule.
              text: part,
            });
          return;
        }
      }

      const detail: Array<{ icon?: ReportCategory; text: string }> = [];
      if (event.driver !== undefined)
        detail.push({ icon: "build", text: event.driver });
      detail.push({
        icon: "contract",
        text: `attempt ${event.attemptOrdinal}`,
      });
      if (event.reason !== undefined)
        detail.push({
          icon: "gate",
          text: REASON_TEXT[event.reason] ?? event.reason,
        });

      const text = renderReport({
        category,
        title:
          category === "success"
            ? "Task succeeded"
            : category === "failure"
              ? "Task failed"
              : `Task ${event.outcome}`,
        subject: event.taskId,
        detail,
        ...facts,
      });

      await this.transport.send("sendMessage", {
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
      });
    } catch {
      // Intentionally silent. A notifier that can throw into the execution path
      // is worse than no notifier: it converts "we could not tell you" into
      // "the work broke".
    }
  }
}
