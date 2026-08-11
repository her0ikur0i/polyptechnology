import assert from "node:assert/strict";
import test from "node:test";
import {
  splitForTelegram,
  budgetBar,
  escapeHtml,
  formatTokens,
  formatUsd,
  renderApproval,
  renderReport,
} from "../src/telegram/report.js";

test("escaping covers exactly Telegram's HTML markup characters", () => {
  // Exactly three, not a general-purpose HTML escaper. Escaping more would show
  // literal entities to the owner; escaping fewer is the MarkdownV2 failure all
  // over again.
  assert.equal(escapeHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  // Quotes and apostrophes are NOT markup to Telegram and must survive intact.
  assert.equal(escapeHtml(`it's "fine"`), `it's "fine"`);
  // Ampersand first, or the escapes of the other two get double-escaped.
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
});

test("a report that quotes paths and identifiers survives intact", () => {
  // The exact content shape that broke the CONTRACT-016 live probe under
  // MarkdownV2: file paths, parentheses, underscores, asterisks, backticks.
  const rendered = renderReport({
    category: "failure",
    title: "Verification failed",
    subject: "src/gateway/cli-adapters.ts (invokeStreaming)",
    detail: [
      { icon: "gate", text: "format:check failed on 3 files" },
      { text: "a_b_c *not italics* `not code`" },
    ],
  });

  assert.ok(rendered.includes("src/gateway/cli-adapters.ts (invokeStreaming)"));
  assert.ok(rendered.includes("a_b_c *not italics* `not code`"));
  assert.ok(rendered.startsWith("❌ <b>Verification failed</b>"));
});

test("the first line answers 'do I need to act' on its own", () => {
  const rendered = renderReport({ category: "success", title: "Run finished" });
  assert.equal(rendered.split("\n")[0], "✅ <b>Run finished</b>");
});

test("usage and budget appear in the report, not only in the dashboard", () => {
  const rendered = renderReport({
    category: "success",
    title: "Reply delivered",
    usage: {
      provider: "claude",
      model: "claude-sonnet-5",
      inputTokens: 12480,
      outputTokens: 3210,
      cacheReadTokens: 1024,
      costUsdMicros: 18_400,
    },
    budget: { spentUsdMicros: 740_000, limitUsdMicros: 2_000_000 },
  });

  assert.ok(rendered.includes("🤖 <code>claude-sonnet-5</code> · claude"));
  assert.ok(rendered.includes("🎟 12,480 in · 3,210 out · 1,024 cached"));
  assert.ok(rendered.includes("💰 $0.0184"));
  assert.ok(rendered.includes("📊"));
  assert.ok(rendered.includes("37%"));
  assert.ok(rendered.includes("$1.26 left of $2.00"));
});

test("cached tokens are omitted when there are none, rather than shown as zero", () => {
  const rendered = renderReport({
    category: "success",
    title: "Reply delivered",
    usage: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      costUsdMicros: 3,
    },
  });
  assert.ok(rendered.includes("🎟 100 in · 20 out"));
  assert.ok(!rendered.includes("cached"));
});

test("sub-cent costs stay legible instead of rounding to $0.00", () => {
  // A per-message cost is almost always sub-cent. Two decimal places would
  // render every single reply as "$0.00", which tells the owner nothing.
  assert.equal(formatUsd(3), "$0.0000");
  assert.equal(formatUsd(1_840), "$0.0018");
  assert.equal(formatUsd(18_400), "$0.0184");
  assert.equal(formatUsd(1_260_000), "$1.26");
  assert.equal(formatUsd(0), "$0.00");
  // Never negative, whatever the ledger hands over.
  assert.equal(formatUsd(-5), "$0.00");
});

test("token counts are grouped and never negative or fractional", () => {
  assert.equal(formatTokens(12480), "12,480");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(-3), "0");
  assert.equal(formatTokens(10.7), "10");
});

test("the budget bar conveys 'nearly gone' at a glance", () => {
  assert.deepEqual(budgetBar(0, 2_000_000), { bar: "░░░░░░░░░░", percent: 0 });
  assert.deepEqual(budgetBar(1_000_000, 2_000_000), {
    bar: "█████░░░░░",
    percent: 50,
  });
  assert.deepEqual(budgetBar(1_900_000, 2_000_000), {
    bar: "█████████░",
    percent: 95,
  });
  // Overspend clamps rather than drawing a bar longer than the track.
  assert.deepEqual(budgetBar(3_000_000, 2_000_000), {
    bar: "██████████",
    percent: 100,
  });
  // A zero limit is not a division-by-zero crash in a failure notifier.
  assert.deepEqual(budgetBar(10, 0), { bar: "", percent: 0 });
});

test("evidence is bounded so a failure report is never refused for length", () => {
  const rendered = renderReport({
    category: "failure",
    title: "Task failed",
    evidence: "E".repeat(5_000),
  });
  // Telegram rejects messages over 4096 characters. A failure report refused
  // for being too long fails exactly when it matters most.
  assert.ok(rendered.length < 4_096);
  assert.ok(rendered.includes("<pre>"));
});

test("evidence containing markup cannot break out of the code block", () => {
  const rendered = renderReport({
    category: "failure",
    title: "Task failed",
    evidence: "</pre><b>injected</b>",
  });
  assert.ok(rendered.includes("&lt;/pre&gt;&lt;b&gt;injected&lt;/b&gt;"));
  assert.ok(!rendered.includes("<b>injected</b>"));
});

test("an approval carries enough context to decide without the dashboard", () => {
  const { text, reply_markup } = renderApproval({
    category: "approval",
    title: "Approve generation run",
    subject: "Vendor invoice tracker",
    token: "t".repeat(43),
    expiresAt: new Date(Date.now() + 30 * 60_000),
    detail: [{ icon: "build", text: "2 products · 6 milestones" }],
    usage: {
      provider: "claude",
      model: "claude-sonnet-5",
      inputTokens: 4218,
      outputTokens: 512,
      costUsdMicros: 3_100,
    },
    budget: { spentUsdMicros: 680_000, limitUsdMicros: 2_000_000 },
  });

  assert.ok(text.includes("📋 <b>Approve generation run</b>"));
  assert.ok(text.includes("💰 $0.0031"));
  assert.ok(text.includes("$1.32 left of $2.00"));
  assert.ok(/⏱ Expires in (29|30) min/.test(text));

  const markup = reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  assert.deepEqual(
    markup.inline_keyboard[0]!.map((b) => b.text),
    ["✅ Approve", "❌ Deny"],
  );
  // The callback shape parseTelegramCallback() already validates -- changing it
  // here would silently break every tap.
  assert.equal(
    markup.inline_keyboard[0]![0]!.callback_data,
    `approve:${"t".repeat(43)}`,
  );
  assert.equal(
    markup.inline_keyboard[0]![1]!.callback_data,
    `deny:${"t".repeat(43)}`,
  );
});

test("an already-expired approval reports zero minutes, never negative", () => {
  const { text } = renderApproval({
    category: "approval",
    title: "Approve",
    token: "t".repeat(43),
    expiresAt: new Date(Date.now() - 60_000),
  });
  assert.ok(text.includes("⏱ Expires in 0 min"));
});

test("a long answer is split rather than truncated", () => {
  // Truncating at 4,000 characters loses the end of an answer, which is
  // usually where it concludes something. Adapted from APEX-V2, the owner's
  // first-generation factory, where this already worked.
  const paragraph = "x".repeat(1_200);
  const text = [paragraph, paragraph, paragraph, paragraph].join("\n\n");
  const parts = splitForTelegram(text);

  assert.ok(parts.length > 1, "expected a split, not one oversized message");
  for (const part of parts) assert.ok(part.length <= 4_000);
  // Nothing is lost: reassembling recovers every character of content.
  assert.equal(parts.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("splitting prefers a paragraph break over a mid-word cut", () => {
  const first = "a".repeat(3_000);
  const second = "b".repeat(2_000);
  const parts = splitForTelegram(`${first}\n\n${second}`);
  assert.equal(parts[0], first);
  assert.equal(parts[1], second);
});

test("a break too early in the window is ignored", () => {
  // A newline at character 10 of a 4,000-character budget would produce a stub
  // and waste a message, so the split falls back to the full window.
  const text = "short\n" + "y".repeat(8_000);
  const parts = splitForTelegram(text);
  assert.ok(parts[0]!.length > 2_000, "refused to emit a stub first chunk");
});

test("text within the limit is returned untouched", () => {
  assert.deepEqual(splitForTelegram("short answer"), ["short answer"]);
});
