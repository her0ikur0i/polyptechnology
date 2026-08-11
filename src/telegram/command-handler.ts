import type { CommandFacts } from "./command-facts.js";
import type { TelegramRequester } from "./gateway.js";
import type { TelegramUpdateHandler, UpdateOrigin } from "./poller.js";
import {
  ICONS,
  budgetBar,
  escapeHtml,
  formatUsd,
  renderReport,
  splitForTelegram,
} from "./report.js";

// The closed command set.
//
// "Closed" is the whole design. Every entry here is read-only, and a message
// that is not one of them is refused rather than interpreted -- no fuzzy
// matching, no "did you mean", no falling through to the assistant. The
// assistant is reachable by just talking; a command that almost matched
// something is exactly where a channel starts doing things nobody asked for.
//
// This survives Amendment 1 unchanged. The assistant gained tools; the command
// surface did not, because a command is answered without a model in the loop
// and therefore without any judgement about what was meant.
export const COMMANDS = {
  status: "overall factory state",
  runs: "what is executing right now",
  approvals: "decisions waiting for you",
  budget: "spend against the limits",
  help: "this list",
} as const;

export type CommandName = keyof typeof COMMANDS;

const MAX_ROWS = 10;

// Telegram sends "/status@PolypTech_bot" in groups and allows arguments after
// the command. The suffix is stripped; arguments are **dropped, not parsed** --
// a closed set that quietly accepted parameters would not be closed.
export function parseCommand(text: string): CommandName | undefined {
  const first = text.trim().split(/\s+/, 1)[0] ?? "";
  if (!first.startsWith("/")) return undefined;
  const name = first.slice(1).split("@", 1)[0]?.toLowerCase() ?? "";
  return name in COMMANDS ? (name as CommandName) : undefined;
}

export function renderHelp(): string {
  return renderReport({
    category: "contract",
    title: "Commands",
    detail: Object.entries(COMMANDS).map(([name, description]) => ({
      text: `/${name} — ${description}`,
    })),
  });
}

// Names what is available instead of only saying no. A refusal that leaves the
// owner guessing what they were allowed to type is a worse answer than the
// command would have been.
export function renderRefusal(attempted: string): string {
  return [
    `${ICONS.stopped} <b>Not a command</b>`,
    `<code>${escapeHtml(attempted.slice(0, 64))}</code> is not in the command set, so nothing was run.`,
    "",
    ...Object.entries(COMMANDS).map(
      ([name, description]) => `/${name} — ${escapeHtml(description)}`,
    ),
    "",
    "Anything else: just say it in a normal message and the assistant answers.",
  ].join("\n");
}

function relative(from: Date, to: Date): string {
  const minutes = Math.round((from.getTime() - to.getTime()) / 60_000);
  if (minutes <= 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function untilText(expiresAt: Date, now: Date): string {
  const minutes = Math.max(
    0,
    Math.round((expiresAt.getTime() - now.getTime()) / 60_000),
  );
  return minutes < 60
    ? `${minutes} min left`
    : `${Math.round(minutes / 60)} h left`;
}

export interface CommandRenderOptions {
  now?: Date;
}

export class TelegramCommandService {
  constructor(private readonly facts: CommandFacts) {}

  async render(
    command: CommandName,
    options: CommandRenderOptions = {},
  ): Promise<string> {
    const now = options.now ?? new Date();
    switch (command) {
      case "help":
        return renderHelp();
      case "status":
        return this.renderStatus(now);
      case "runs":
        return this.renderRuns();
      case "approvals":
        return this.renderApprovals(now);
      case "budget":
        return this.renderBudget();
    }
  }

  private async renderStatus(now: Date): Promise<string> {
    const facts = await this.facts.status();
    const active = facts.states.reduce((sum, row) => sum + row.count, 0);

    const detail: Array<{ text: string }> = [
      {
        text:
          active === 0
            ? "no work in flight"
            : facts.states
                .map((row) => `${row.count} ${row.state}`)
                .join(" · "),
      },
      {
        text:
          facts.pendingApprovals === 0
            ? "no approvals waiting"
            : `${facts.pendingApprovals} approval${facts.pendingApprovals === 1 ? "" : "s"} waiting — /approvals`,
      },
    ];
    if (facts.lastFinishedAt !== undefined)
      detail.push({
        text: `last provider call ${relative(now, facts.lastFinishedAt)}`,
      });

    return renderReport({
      // An idle factory is not a success and not a failure; it is a state. The
      // icon says "running" only when something actually is.
      category: active === 0 ? "project" : "running",
      title: active === 0 ? "Idle" : `${active} active`,
      detail,
      ...(facts.budget === undefined
        ? {}
        : {
            budget: {
              spentUsdMicros: facts.budget.spentUsdMicros,
              limitUsdMicros: facts.budget.limitUsdMicros,
            },
          }),
    });
  }

  private async renderRuns(): Promise<string> {
    const runs = await this.facts.activeRuns(MAX_ROWS);
    if (runs.length === 0)
      return renderReport({
        category: "project",
        title: "Nothing running",
        detail: [{ text: "No task is queued, leased or executing." }],
      });

    return renderReport({
      category: "running",
      title: `${runs.length} active run${runs.length === 1 ? "" : "s"}`,
      detail: runs.flatMap((run) => [
        {
          icon: "build" as const,
          text: `${run.driver ?? "task"} — ${run.state}`,
        },
        {
          // The short id is enough to match a run against a report in the same
          // chat, and a full uuid per line makes the message unreadable on a
          // phone.
          text: `  ${run.taskId.slice(0, 8)} · attempt ${run.attemptCount}/${run.maxAttempts}${
            run.leasedBy === undefined ? "" : ` · ${run.leasedBy}`
          } · ${formatUsd(run.spentUsdMicros)}`,
        },
      ]),
    });
  }

  private async renderApprovals(now: Date): Promise<string> {
    const approvals = await this.facts.pendingApprovals(MAX_ROWS);
    if (approvals.length === 0)
      return renderReport({
        category: "success",
        title: "Nothing waiting on you",
        detail: [{ text: "No approval is pending." }],
      });

    return renderReport({
      category: "approval",
      title: `${approvals.length} approval${approvals.length === 1 ? "" : "s"} waiting`,
      // Deliberately no buttons here. Approval tokens are single-use and
      // identity-bound, and they are issued when the approval is *delivered*;
      // minting a fresh one because someone typed /approvals would turn a
      // read-only command into a way to create authority. The owner answers on
      // the original message, which still has its buttons.
      detail: approvals.flatMap((approval) => [
        { icon: "approval" as const, text: approval.summary },
        {
          text: `  ${approval.targetKind} · risk ${approval.risk} · ${untilText(approval.expiresAt, now)}`,
        },
      ]),
    });
  }

  private async renderBudget(): Promise<string> {
    const accounts = await this.facts.budget();
    if (accounts.length === 0)
      return renderReport({
        category: "budget",
        title: "No budget accounts",
        detail: [{ text: "Nothing has been spent through the gateway yet." }],
      });

    const lines: string[] = [`${ICONS.budget} <b>Budget</b>`, ""];
    for (const account of accounts) {
      const { bar, percent } = budgetBar(
        account.spentUsdMicros + account.reservedUsdMicros,
        account.limitUsdMicros,
      );
      lines.push(`<code>${escapeHtml(account.scopeId)}</code>`);
      lines.push(
        `${bar} ${percent}% · ${formatUsd(account.spentUsdMicros)} spent of ${formatUsd(account.limitUsdMicros)}`,
      );
      // Reservations are money that is committed but not yet charged. Leaving
      // them out makes the remaining figure look larger than it is spendable.
      if (account.reservedUsdMicros > 0)
        lines.push(`  ${formatUsd(account.reservedUsdMicros)} reserved`);
    }
    return lines.join("\n");
  }
}

export interface TelegramCommandDeps {
  service: TelegramCommandService;
  requester: TelegramRequester;
}

export class TelegramCommandHandler implements TelegramUpdateHandler {
  constructor(private readonly deps: TelegramCommandDeps) {}

  async handle(update: unknown, origin: UpdateOrigin): Promise<void> {
    const text = messageTextOf(update);
    if (text === undefined || origin.chatId === undefined) return;
    // Not a slash message: the conversation handler owns it. Both sides decide
    // for themselves rather than one asking the other, which is why the rule is
    // stated identically in both files.
    if (!text.startsWith("/")) return;

    const command = parseCommand(text);
    const body =
      command === undefined
        ? renderRefusal(text)
        : // A command that cannot be answered says so as a report, in the same
          // chat, rather than throwing into the poller and looking like silence
          // to the owner.
          await this.deps.service.render(command).catch((error) =>
            renderReport({
              category: "failure",
              title: `/${command} failed`,
              detail: [
                {
                  text:
                    error instanceof Error ? error.message : "unknown failure",
                },
              ],
            }),
          );

    for (const part of splitForTelegram(body))
      await this.deps.requester.call("sendMessage", {
        chat_id: origin.chatId,
        text: part,
        parse_mode: "HTML",
      });
  }
}

function messageTextOf(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const message = (update as Record<string, unknown>).message as
    Record<string, unknown> | undefined;
  const text = message?.text;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
