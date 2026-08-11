// Formatting for everything this system tells the owner through Telegram.
//
// Three constraints shaped it, all learned rather than assumed:
//
// 1. **HTML parse mode, not MarkdownV2.** The CONTRACT-016 live probe's first
//    report failed to send because MarkdownV2 requires escaping roughly
//    eighteen characters, and report text quotes file paths, parentheses and
//    identifiers constantly. HTML needs exactly three. A failure report that
//    itself fails to send -- precisely when something is wrong and the owner
//    most needs it -- is the worst bug this surface can have, so the escaping
//    surface is kept as small as possible and every interpolated value goes
//    through one function.
// 2. **Outcome first.** These are read on a phone, often while doing something
//    else. The first line has to answer "do I need to act?" on its own.
// 3. **Icons carry category, not decoration.** Each one maps to a fixed
//    meaning, so scanning a chat history works without reading every word.

export const ICONS = {
  success: "✅",
  failure: "❌",
  warning: "⚠️",
  running: "⏳",
  stopped: "🛑",
  approval: "📋",
  model: "🤖",
  tokens: "🎟",
  cost: "💰",
  budget: "📊",
  build: "🔨",
  gate: "🔒",
  deploy: "🚀",
  project: "📦",
  contract: "📄",
  incident: "🚨",
} as const;

export type ReportCategory = keyof typeof ICONS;

// The complete HTML escaping surface Telegram requires. Deliberately not a
// general-purpose HTML escaper: Telegram's parser only treats these three as
// markup, and escaping more would show literal entities to the owner.
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface UsageLine {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsdMicros: number;
}

export interface BudgetLine {
  spentUsdMicros: number;
  limitUsdMicros: number;
  // Committed but not yet charged. Optional so a caller that genuinely has no
  // reservation figure is not forced to invent a zero, but every caller in
  // this repository supplies it.
  reservedUsdMicros?: number;
}

// The one budget calculation.
//
// There were two. A run report showed a scope at 6% with "$4.68 left" while
// /budget showed the same scope at 18% with "$0.60 reserved", because the
// report counted spend and the command counted spend plus reservations. The
// owner read both in the same batch of messages. Reservations are money that
// is committed and cannot be spent again, so excluding them overstates the
// headroom by exactly the amount most likely to be stuck.
//
// Both surfaces now call this, which is the only way two numbers stay equal.
export function budgetSummary(line: BudgetLine): {
  bar: string;
  percent: number;
  committedUsdMicros: number;
  remainingUsdMicros: number;
  reservedUsdMicros: number;
} {
  const reservedUsdMicros = Math.max(0, line.reservedUsdMicros ?? 0);
  const committedUsdMicros =
    Math.max(0, line.spentUsdMicros) + reservedUsdMicros;
  const { bar, percent } = budgetBar(committedUsdMicros, line.limitUsdMicros);
  return {
    bar,
    percent,
    committedUsdMicros,
    remainingUsdMicros: Math.max(0, line.limitUsdMicros - committedUsdMicros),
    reservedUsdMicros,
  };
}

export interface Report {
  category: ReportCategory;
  title: string;
  // Optional second line for context the title cannot carry -- a contract id, a
  // project name, a milestone.
  subject?: string;
  // Free-form lines, each optionally carrying its own category icon.
  detail?: ReadonlyArray<{ icon?: ReportCategory; text: string }>;
  usage?: UsageLine;
  budget?: BudgetLine;
  // Rendered as a monospace block. Used for failure output, where the exact
  // characters matter and wrapping would mislead.
  evidence?: string;
}

const NUMBER = new Intl.NumberFormat("en-US");

export function formatTokens(value: number): string {
  return NUMBER.format(Math.max(0, Math.trunc(value)));
}

// Micro-dollars are the ledger's unit. Below a dollar, four decimal places are
// what makes a per-message cost legible at all -- a single reply is routinely
// under two cents, and two decimals would render most of them as "$0.02" or
// "$0.00", which tells the owner nothing they can add up. Above a dollar,
// two decimals is what anyone actually reads.
export function formatUsd(micros: number): string {
  const dollars = Math.max(0, micros) / 1_000_000;
  if (dollars === 0) return "$0.00";
  return dollars < 1 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

// A ten-cell bar. Telegram has no progress widget, and a bare percentage does
// not convey "nearly gone" at a glance the way a filling bar does.
export function budgetBar(spentUsdMicros: number, limitUsdMicros: number) {
  if (limitUsdMicros <= 0) return { bar: "", percent: 0 };
  const percent = Math.min(
    100,
    Math.round((Math.max(0, spentUsdMicros) / limitUsdMicros) * 100),
  );
  // floor, not round: at 95% a rounded bar shows ten filled cells, and a full
  // bar has to mean exhausted or it stops meaning anything.
  const filled = Math.min(10, Math.floor(percent / 10));
  return { bar: "█".repeat(filled) + "░".repeat(10 - filled), percent };
}

export function renderReport(report: Report): string {
  const lines: string[] = [
    `${ICONS[report.category]} <b>${escapeHtml(report.title)}</b>`,
  ];
  if (report.subject !== undefined)
    lines.push(`<i>${escapeHtml(report.subject)}</i>`);

  if (report.detail !== undefined && report.detail.length > 0) {
    lines.push("");
    for (const item of report.detail)
      lines.push(
        item.icon === undefined
          ? escapeHtml(item.text)
          : `${ICONS[item.icon]} ${escapeHtml(item.text)}`,
      );
  }

  if (report.usage !== undefined) {
    const usage = report.usage;
    lines.push("");
    lines.push(
      `${ICONS.model} <code>${escapeHtml(usage.model)}</code> · ${escapeHtml(usage.provider)}`,
    );
    const cached =
      usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0
        ? ` · ${formatTokens(usage.cacheReadTokens)} cached`
        : "";
    lines.push(
      `${ICONS.tokens} ${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out${cached}`,
    );
    lines.push(`${ICONS.cost} ${formatUsd(usage.costUsdMicros)}`);
  }

  if (report.budget !== undefined) {
    const { bar, percent, remainingUsdMicros, reservedUsdMicros } =
      budgetSummary(report.budget);
    lines.push(
      `${ICONS.budget} ${bar} ${percent}% · ${formatUsd(remainingUsdMicros)} left of ${formatUsd(report.budget.limitUsdMicros)}` +
        // Named only when there is one. A "$0.00 reserved" on every report is
        // exactly the kind of zero-valued line this contract is removing.
        (reservedUsdMicros > 0
          ? ` · ${formatUsd(reservedUsdMicros)} reserved`
          : ""),
    );
  }

  if (report.evidence !== undefined && report.evidence.trim().length > 0) {
    lines.push("");
    // Bounded: Telegram rejects messages over 4096 characters, and a failure
    // report that is refused for being too long fails exactly when it matters.
    // Trimming the evidence is always better than losing the report.
    const trimmed = report.evidence.trim().slice(0, 1_200);
    lines.push(`<pre>${escapeHtml(trimmed)}</pre>`);
  }

  return lines.join("\n");
}

// Telegram refuses messages over 4096 characters. Truncating an answer loses
// its ending, which is usually the part that concludes something -- so long
// text is split across messages instead.
//
// The rule is adapted from APEX-V2, the owner's first-generation factory, where
// this feature already worked: break at a paragraph if there is one, else a
// line, else a space -- but only when the break lands past the halfway mark,
// because a break at character 12 of a 4000-character budget produces a stub
// and wastes a message.
export function splitForTelegram(text: string, maxLength = 4_000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    const half = Math.floor(maxLength / 2);

    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");

    const cut = safeCut(
      remaining,
      paragraph > half
        ? paragraph + 2
        : line > half
          ? line + 1
          : space > half
            ? space + 1
            : maxLength,
    );

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks.filter((chunk) => chunk.length > 0);
}

// Moves a cut back off the middle of a surrogate pair.
//
// JavaScript string indices are UTF-16 code units, and every emoji outside the
// basic plane is two of them. The paragraph/line/space branches land on ASCII
// by construction, but the `maxLength` fallback is a raw index — so a 4,000
// character answer with no break point in its second half could be cut through
// the middle of a 🔨, and both halves render as `�`. In a formatter whose only
// job is delivering text intact, that is the whole job failing.
export function safeCut(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const code = text.charCodeAt(cut - 1);
  // A high surrogate immediately before the cut means its low half is on the
  // other side.
  return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}

export interface ApprovalPrompt extends Report {
  token: string;
  expiresAt: Date;
}

// A decision the owner can make from the message alone: what is being approved,
// what it costs, what budget remains, and two buttons. Before this, the message
// was a bare summary line and an ISO timestamp, which is not enough to decide
// from without opening the dashboard -- defeating the point of asking on a
// phone.
export function renderApproval(prompt: ApprovalPrompt): {
  text: string;
  reply_markup: unknown;
} {
  const minutesLeft = Math.max(
    0,
    Math.round((prompt.expiresAt.getTime() - Date.now()) / 60_000),
  );
  const text = [
    renderReport(prompt),
    "",
    `⏱ Expires in ${minutesLeft} min`,
  ].join("\n");

  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${prompt.token}` },
          { text: "❌ Deny", callback_data: `deny:${prompt.token}` },
        ],
      ],
    },
  };
}
