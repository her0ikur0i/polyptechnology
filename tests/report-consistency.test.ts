import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetSummary,
  renderReport,
  safeCut,
  splitForTelegram,
} from "../src/telegram/report.js";
import {
  TelegramCommandService,
  type CommandRenderOptions,
} from "../src/telegram/command-handler.js";
import type {
  ApprovalLine,
  BudgetAccountLine,
  CommandFacts,
  RunLine,
  StatusFacts,
} from "../src/telegram/command-facts.js";
import {
  kindOf,
  taskHeadline,
  trimSubject,
} from "../src/telegram/task-label.js";

// The owner read two messages in the same batch that disagreed about the same
// budget scope: a run report said "6% · $4.68 left" while /budget said "18%"
// with "$0.60 reserved". Two surfaces, one scope, two answers, because each
// did its own arithmetic.

const ACCOUNT: BudgetAccountLine = {
  scopeId: "92f89ba7-1766-5c8e-aada-496b50deca67",
  spentUsdMicros: 320_192,
  reservedUsdMicros: 600_000,
  limitUsdMicros: 5_000_000,
};

class OneAccount implements CommandFacts {
  async status(): Promise<StatusFacts> {
    return { states: [], pendingApprovals: 0, budget: ACCOUNT };
  }
  async activeRuns(): Promise<ReadonlyArray<RunLine>> {
    return [];
  }
  async pendingApprovals(): Promise<ReadonlyArray<ApprovalLine>> {
    return [];
  }
  async budget(): Promise<ReadonlyArray<BudgetAccountLine>> {
    return [ACCOUNT];
  }
}

const percentIn = (text: string): string | undefined =>
  /(\d+)% · /.exec(text)?.[1];
const leftIn = (text: string): string | undefined =>
  /· (\$[\d,.]+) left/.exec(text)?.[1];

test("a run report and /budget agree about the same scope", async () => {
  const service = new TelegramCommandService(new OneAccount());
  const options: CommandRenderOptions = { now: new Date() };

  const budgetText = await service.render("budget", options);
  const statusText = await service.render("status", options);
  const runReport = renderReport({
    category: "failure",
    title: "Chat reply failed",
    budget: {
      spentUsdMicros: ACCOUNT.spentUsdMicros,
      reservedUsdMicros: ACCOUNT.reservedUsdMicros,
      limitUsdMicros: ACCOUNT.limitUsdMicros,
    },
  });

  // The exact contradiction, asserted so it cannot come back: 6 versus 18.
  assert.equal(percentIn(budgetText), percentIn(runReport));
  assert.equal(percentIn(statusText), percentIn(runReport));
  assert.equal(leftIn(budgetText), leftIn(runReport));
  assert.equal(leftIn(statusText), leftIn(runReport));
});

test("reservations count against what is left, because they cannot be spent twice", () => {
  const summary = budgetSummary({
    spentUsdMicros: 320_192,
    reservedUsdMicros: 600_000,
    limitUsdMicros: 5_000_000,
  });
  assert.equal(summary.committedUsdMicros, 920_192);
  // $4.08 truly available, not the $4.68 the old report showed.
  assert.equal(summary.remainingUsdMicros, 4_079_808);
  assert.equal(summary.percent, 18);
});

test("a scope with no reservation says nothing about reservations", () => {
  const text = renderReport({
    category: "success",
    title: "Patch succeeded",
    budget: { spentUsdMicros: 1_000, limitUsdMicros: 5_000_000 },
  });
  // "$0.00 reserved" on every message is exactly the zero-valued noise this
  // contract removes.
  assert.ok(!text.includes("reserved"));
});

test("splitting never cuts an emoji in half", () => {
  // No spaces and no newlines anywhere, so every cut takes the raw-index
  // fallback -- the only branch that could ever land mid-character.
  const hammer = "🔨";
  const text = hammer.repeat(3_000);

  for (const maxLength of [11, 99, 101, 999, 4_000]) {
    const parts = splitForTelegram(text, maxLength);
    assert.ok(!parts.join("").includes("�"), "no replacement characters");
    for (const part of parts) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(part), "no dangling high surrogate");
      assert.ok(!/^[\uDC00-\uDFFF]/.test(part), "no orphan low surrogate");
    }
    // Nothing lost and nothing invented.
    assert.equal(parts.join(""), text);
  }
});

test("safeCut only steps back when it is standing on a surrogate pair", () => {
  assert.equal(safeCut("plain ascii", 5), 5);
  // "a🔨b": indices 1 and 2 are the two halves of the hammer.
  assert.equal(safeCut("a🔨b", 2), 1);
  assert.equal(safeCut("a🔨b", 3), 3);
  // Out-of-range cuts are returned untouched rather than clamped, because the
  // caller's own bounds checks own that.
  assert.equal(safeCut("abc", 0), 0);
  assert.equal(safeCut("abc", 99), 99);
});

test("a task is named by what it is, never by its driver id", () => {
  assert.equal(kindOf("conversation_reply"), "Chat reply");
  assert.equal(kindOf("ai_patch_executor"), "Patch");
  assert.equal(kindOf("blueprint_translation"), "Blueprint translation");
  // A driver added by a later contract must not leak its enum value into a
  // message; a generic word is the better failure.
  assert.equal(kindOf("some_future_driver"), "Task");
  assert.equal(kindOf(undefined), "Task");
});

test("a subject is collapsed to one bounded line", () => {
  assert.equal(trimSubject("  hello\n  world  "), "hello world");
  assert.equal(trimSubject(""), undefined);
  assert.equal(trimSubject("   "), undefined);
  assert.equal(trimSubject(undefined), undefined);

  const long = trimSubject("word ".repeat(100));
  assert.ok(long !== undefined && long.length <= 73);
  assert.ok(long.endsWith("…"));
  // Cut at a word boundary, not mid-word.
  assert.ok(!long.includes("wor…"));
});

test("a subject truncated mid-emoji does not leave half of one", () => {
  // The same hazard safeCut fixes in splitForTelegram, in the function this
  // contract added. Owner questions contain emoji.
  const trimmed = trimSubject("🔨".repeat(100));
  assert.ok(trimmed !== undefined);
  assert.ok(!trimmed.includes("\uFFFD"));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(trimmed), "no dangling high surrogate");
});

test("the headline reads as a sentence about the work", () => {
  assert.equal(
    taskHeadline({ kind: "Chat reply" }, "failed"),
    "Chat reply failed",
  );
  assert.equal(taskHeadline({ kind: "Patch" }, "succeeded"), "Patch succeeded");
  // An outcome this build does not know is still rendered, not swallowed.
  assert.equal(
    taskHeadline({ kind: "Task" }, "some_future_state"),
    "Task some_future_state",
  );
});
