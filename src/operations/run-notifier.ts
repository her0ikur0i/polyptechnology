import type { Pool } from "pg";
import { renderReport, splitForTelegram } from "../telegram/report.js";
import type {
  BudgetLine,
  ReportCategory,
  UsageLine,
} from "../telegram/report.js";
import type { TelegramTransport } from "../telegram/gateway.js";
import {
  kindOf,
  subjectLine,
  taskHeadline,
  type TaskDescription,
} from "../telegram/task-label.js";

export interface TaskFinished {
  taskId: string;
  attemptOrdinal: number;
  outcome: string;
  reason?: string;
  driver?: string;
  // The error the supervisor actually caught, when it caught one.
  detail?: string;
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
      "SELECT spent_usd_micros, reserved_usd_micros, max_cost_usd_micros FROM ai_budget_accounts WHERE scope_id = $1",
      [row.budget_scope_id],
    );
    const account = budget.rows[0] as
      | {
          spent_usd_micros: string;
          reserved_usd_micros: string;
          max_cost_usd_micros: string;
        }
      | undefined;

    return account === undefined
      ? { usage }
      : {
          usage,
          budget: {
            spentUsdMicros: Number(account.spent_usd_micros),
            // Reservations were missing here and present in /budget, which is
            // how the same scope came to read 6% in one message and 18% in
            // the next.
            reservedUsdMicros: Number(account.reserved_usd_micros),
            limitUsdMicros: Number(account.max_cost_usd_micros),
          },
        };
  }

  // What to call this task in front of a person.
  //
  // The kind comes from the driver; the subject comes from whatever that kind
  // of work is actually about. For a chat reply that is the owner's own
  // question, which is the most recognisable thing a report could possibly
  // carry — they wrote it minutes earlier.
  async describe(taskId: string): Promise<TaskDescription> {
    const spec = await this.pool.query(
      `SELECT s.driver, s.input->>'conversationId' AS conversation_id,
              s.input->>'projectId' AS project_id
         FROM operation_task_specs s WHERE s.task_id = $1`,
      [taskId],
    );
    const row = spec.rows[0] as
      | {
          driver: string;
          conversation_id: string | null;
          project_id: string | null;
        }
      | undefined;
    if (row === undefined) return { kind: kindOf(undefined) };

    const kind = kindOf(row.driver);

    if (row.conversation_id !== null) {
      const asked = await this.pool.query(
        `SELECT content FROM conversation_messages
          WHERE conversation_id = $1 AND role = 'owner'
          ORDER BY ordinal DESC LIMIT 1`,
        [row.conversation_id],
      );
      const content = (asked.rows[0] as { content: string } | undefined)
        ?.content;
      if (content !== undefined) return { kind, subject: content };
    }

    if (row.project_id !== null) {
      const project = await this.pool.query(
        "SELECT display_name FROM generated_projects WHERE id = $1",
        [row.project_id],
      );
      const name = (project.rows[0] as { display_name: string } | undefined)
        ?.display_name;
      if (name !== undefined) return { kind, subject: name };
    }

    return { kind };
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
};

// Outcomes that are progress rather than news, and are therefore silent.
//
// A retry is not a decision, cannot be acted on, and says nothing the eventual
// outcome will not say better — but it used to send a message each time, so
// three doomed tasks produced six notifications in ten seconds.
//
// Written as a deny-list, not an allow-list of terminal states. An allow-list
// would silently swallow any state a later contract adds, and "the owner was
// never told" is the exact failure this contract exists to fix. Anything
// unrecognised still reports, as a warning.
export const SILENT_OUTCOMES = new Set(["retry_wait"]);

// How much of a caught error a report will carry. Enough to identify the
// failure, far short of Telegram's 4096-character ceiling.
export const DETAIL_LIMIT = 600;

// Failure reasons the work engine produces, phrased as something a person
// woken by their phone can act on rather than as an enum value.
//
// `invalid_output` used to read "provider returned unusable output". That is a
// specific, checkable accusation, and it was false every time the driver threw
// before reaching a provider — which the owner could see, because the same
// message said `0 in · 0 out` and `$0.00`.
//
// Its replacement, "the run failed before producing output", was the same
// mistake one step quieter. `invalid_output` is a catch-all for *every* throw
// from every driver, so it also covers throws that happen long after output
// exists. The owner read this on their phone:
//
//   ❌ Patch failed · the run failed before producing output
//      patch failed to apply cleanly: error: corrupt patch at line 76
//
// A patch that failed to apply is output. The two lines contradict each other,
// and the detail line is the honest one. The catch-all now claims only what a
// catch-all can know -- that the run failed -- and lets the carried error say
// what happened.
const REASON_TEXT: Record<string, string> = {
  policy: "refused by routing policy",
  verification: "verification gate failed",
  worker: "worker or transport failure",
  invalid_output: "the run failed",
  empty_provider_response: "the model returned an empty answer",
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
      // Progress is silent; anything that ended, or that this build does not
      // recognise, is reported.
      if (SILENT_OUTCOMES.has(event.outcome)) return;

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

      // Losing the label must cost the label, not the report. `.catch()` alone
      // is not enough: a facts object that throws *synchronously* — an older
      // deployment without describe(), a stubbed one in a test — throws before
      // the catch is attached, and the outer handler would swallow the entire
      // message. The owner would be told nothing, which is worse than being
      // told "Task failed" without a nice name.
      let description: TaskDescription = { kind: kindOf(event.driver) };
      try {
        if (this.facts !== undefined)
          description = await this.facts.describe(event.taskId);
      } catch {
        // Keep the driver-derived fallback.
      }

      const detail: Array<{ icon?: ReportCategory; text: string }> = [];

      // Attempts are worth reporting only when there was more than one. "1 of
      // 3" on every successful task is a line that has never once told the
      // owner anything.
      if (event.attemptOrdinal > 1)
        detail.push({
          icon: "contract",
          text: `after ${event.attemptOrdinal} attempts`,
        });

      if (event.reason !== undefined)
        detail.push({
          icon: "gate",
          text: REASON_TEXT[event.reason] ?? event.reason,
        });

      // The real error, when the supervisor caught one. This is the line that
      // would have said `idempotency intent mismatch` instead of sending the
      // owner to look at a provider that had never been called.
      //
      // Bounded, because a driver is free to throw a stack trace or a whole
      // provider payload. Telegram rejects anything over 4096 characters, and
      // this notifier swallows send failures by design — so an unbounded error
      // string would turn "the task failed" into total silence, which is the
      // exact failure this contract exists to remove.
      if (event.detail !== undefined && event.detail !== "unknown")
        detail.push({ text: event.detail.slice(0, DETAIL_LIMIT) });

      // No usage row means the gateway was never reached. Saying so is the
      // difference between "your provider misbehaved" and "we refused this
      // before spending anything", and only one of them is true.
      if (category === "failure" && facts.usage === undefined)
        detail.push({
          text: "No provider call was made, nothing was charged.",
        });

      // A chat reply's subject is the owner's own words, so it is quoted.
      // A project name is the system's own noun, so it is not.
      const subject = subjectLine(
        description,
        description.kind === "Chat reply",
      );

      const text = renderReport({
        category,
        title: taskHeadline(description, event.outcome),
        ...(subject === undefined ? {} : { subject }),
        detail,
        ...facts,
      });

      // Split like every other outbound path. This one sent the whole report
      // as a single message, which was safe only while every field in it was
      // bounded — and this contract added a caught error message to it. A
      // report Telegram refuses for length is indistinguishable from no
      // report at all, because the catch below is deliberately silent.
      for (const part of splitForTelegram(text))
        await this.transport.send("sendMessage", {
          chat_id: this.chatId,
          text: part,
          parse_mode: "HTML",
        });
    } catch {
      // Intentionally silent. A notifier that can throw into the execution path
      // is worse than no notifier: it converts "we could not tell you" into
      // "the work broke".
    }
  }
}
