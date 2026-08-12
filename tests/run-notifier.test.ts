import assert from "node:assert/strict";
import test from "node:test";
import { TelegramRunNotifier } from "../src/operations/run-notifier.js";
import type { TelegramTransport } from "../src/telegram/gateway.js";

class RecordingTransport implements TelegramTransport {
  readonly sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  throwOnSend = false;
  async send(method: string, body: unknown) {
    if (this.throwOnSend) throw new Error("telegram unreachable");
    this.sent.push({ method, body: body as Record<string, unknown> });
  }
}

const textOf = (transport: RecordingTransport) =>
  String(transport.sent[0]?.body.text ?? "");

test("a succeeded task reports as a success", async () => {
  const transport = new RecordingTransport();
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 1,
    outcome: "succeeded",
  });

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]!.method, "sendMessage");
  assert.equal(transport.sent[0]!.body.parse_mode, "HTML");
  assert.ok(textOf(transport).startsWith("✅ <b>Task succeeded</b>"));
});

test("a failed task reports the reason in words, not as an enum", async () => {
  const transport = new RecordingTransport();
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 3,
    outcome: "failed",
    reason: "verification",
  });

  const text = textOf(transport);
  assert.ok(text.startsWith("❌ <b>Task failed</b>"));
  // "verification" means nothing to someone woken by their phone.
  assert.ok(text.includes("verification gate failed"));
  assert.ok(text.includes("after 3 attempts"));
});

test("a first-attempt success does not mention attempts at all", async () => {
  const transport = new RecordingTransport();
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 1,
    outcome: "succeeded",
  });
  // "attempt 1" appeared on every report and has never once told the owner
  // anything they could act on.
  assert.ok(!textOf(transport).includes("attempt"));
});

test("a retry is silent — only the ending is news", async () => {
  const transport = new RecordingTransport();
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 2,
    outcome: "retry_wait",
    reason: "invalid_output",
  });
  // Three doomed tasks produced six messages in ten seconds, half of them
  // announcing retries the owner could do nothing about.
  assert.equal(transport.sent.length, 0);
});

test("a failure with no provider attempt says so instead of blaming the provider", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => ({}),
    describe: async () => ({ kind: "Chat reply", subject: "how many .ts?" }),
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({
    taskId: "task-1",
    attemptOrdinal: 3,
    outcome: "failed",
    reason: "invalid_output",
    detail: "idempotency intent mismatch",
  });

  const text = textOf(transport);
  // The first wording accused the provider of returning unusable output on
  // failures where no provider was ever called — visible to the owner as
  // "0 in · 0 out" on the same message.
  assert.ok(!text.includes("provider returned unusable output"));
  // The second wording, "the run failed before producing output", was the same
  // mistake one step quieter: `invalid_output` is a catch-all for every throw
  // from every driver, including throws that happen long after output exists.
  // The owner received "the run failed before producing output" directly above
  // "patch failed to apply cleanly: corrupt patch at line 76" — a patch that
  // failed to apply is output, and the two lines contradicted each other.
  assert.ok(!text.includes("before producing output"));
  // A catch-all may claim only what a catch-all knows.
  assert.ok(text.includes("the run failed"));
  // And the real error is still carried, which is the line that actually says
  // what happened.
  assert.ok(text.includes("idempotency intent mismatch"));
  assert.ok(text.includes("idempotency intent mismatch"));
  assert.ok(text.includes("No provider call was made"));
});

test("a headline names the work and quotes the owner's own question", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => ({}),
    describe: async () => ({
      kind: "Chat reply",
      subject: "ada berapa contract pada project ini?",
    }),
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({
    taskId: "47a0ed46-x",
    attemptOrdinal: 1,
    outcome: "failed",
  });

  const text = textOf(transport);
  assert.ok(text.startsWith("❌ <b>Chat reply failed</b>"));
  assert.ok(text.includes("ada berapa contract pada project ini?"));
  // The uuid was the headline and told the owner nothing.
  assert.ok(!text.includes("47a0ed46"));
});

test("a broken describe() costs the label, not the report", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => ({}),
    describe: () => {
      throw new Error("thrown synchronously, before any promise exists");
    },
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({
    taskId: "task-1",
    attemptOrdinal: 1,
    outcome: "failed",
    driver: "conversation_reply",
  });

  // Degrades to the driver-derived name rather than sending nothing.
  assert.equal(transport.sent.length, 1);
  assert.ok(textOf(transport).startsWith("❌ <b>Chat reply failed</b>"));
});

test("an unrecognised reason is passed through rather than swallowed", async () => {
  const transport = new RecordingTransport();
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 1,
    outcome: "failed",
    reason: "some_future_reason",
  });
  // A reason this build has no phrasing for is still more useful than silence.
  assert.ok(textOf(transport).includes("some_future_reason"));
});

test("an unknown outcome is reported as needing attention, not as success", async () => {
  const transport = new RecordingTransport();
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 1,
    outcome: "some_state_added_later",
  });
  // Defaulting an unrecognised state to ✅ would be the one wrong answer.
  assert.ok(textOf(transport).startsWith("⚠️"));
});

test("usage and budget are included when the ledger has them", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => ({
      usage: {
        provider: "claude",
        model: "claude-sonnet-5",
        inputTokens: 4218,
        outputTokens: 512,
        cacheReadTokens: 0,
        costUsdMicros: 3_100,
      },
      budget: { spentUsdMicros: 500_000, limitUsdMicros: 2_000_000 },
    }),
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({ taskId: "task-1", attemptOrdinal: 1, outcome: "succeeded" });

  const text = textOf(transport);
  assert.ok(text.includes("🎟 4,218 in · 512 out"));
  assert.ok(text.includes("💰 $0.0031"));
  assert.ok(text.includes("$1.50 left of $2.00"));
});

test("a ledger read failure costs the numbers, not the report", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => {
      throw new Error("database unavailable");
    },
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({ taskId: "task-1", attemptOrdinal: 1, outcome: "failed" });

  // Being unable to price a failure is not a reason to stop reporting it.
  assert.equal(transport.sent.length, 1);
  assert.ok(textOf(transport).startsWith("❌"));
  assert.ok(!textOf(transport).includes("🎟"));
});

test("an enormous error message cannot silence the report", async () => {
  const transport = new RecordingTransport();
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 2,
    outcome: "failed",
    reason: "invalid_output",
    // A driver is free to throw a stack trace or a whole provider payload.
    detail: "boom ".repeat(5_000),
  });

  // Telegram refuses anything over 4096 characters and this notifier swallows
  // send failures by design, so an unbounded error string would have turned
  // "the task failed" into total silence.
  assert.ok(transport.sent.length >= 1);
  for (const message of transport.sent)
    assert.ok(String(message.body.text).length <= 4_000);
});

test("a failure report names every tier the run actually walked, in order", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => ({}),
    describe: async () => ({ kind: "Generation" as const }),
    tiersFor: async () => [
      { provider: "deepseek", model: "deepseek-v4-flash", status: "rejected" },
      { provider: "codex", model: "gpt-5.6-terra", status: "rejected" },
      { provider: "claude", model: "claude-sonnet-5", status: "rejected" },
    ],
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({
    taskId: "task-1",
    attemptOrdinal: 5,
    outcome: "failed",
    reason: "verification",
  });

  const text = textOf(transport);
  // The old report named one model. This run walked three; a reader must be
  // able to see all three, in the order they were tried, not just the last.
  assert.ok(
    text.includes(
      "deepseek-v4-flash→rejected, gpt-5.6-terra→rejected, claude-sonnet-5→rejected",
    ),
  );
});

test("a single-tier run does not repeat itself with a redundant tier line", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => ({}),
    describe: async () => ({ kind: "Generation" as const }),
    tiersFor: async () => [
      { provider: "deepseek", model: "deepseek-v4-flash", status: "accepted" },
    ],
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({ taskId: "task-1", attemptOrdinal: 1, outcome: "succeeded" });

  // One tier is already the whole story; a "tiers:" line here would say
  // nothing the rest of the report had not already said.
  assert.ok(!textOf(transport).includes("→"));
});

test("a facts object without tiersFor (an older stub) costs the tier line, not the report", async () => {
  const transport = new RecordingTransport();
  const facts = {
    usageFor: async () => ({}),
    describe: async () => ({ kind: "Generation" as const }),
    // tiersFor deliberately absent -- calling it throws synchronously, the
    // same hazard a synchronously-throwing describe() already covers above.
  };
  await new TelegramRunNotifier(
    transport,
    "chat-1",
    facts as never,
  ).taskFinished({
    taskId: "task-1",
    attemptOrdinal: 3,
    outcome: "failed",
    reason: "verification",
  });

  assert.equal(transport.sent.length, 1);
  assert.ok(textOf(transport).startsWith("❌"));
});

test("a Telegram outage never propagates into the execution path", async () => {
  const transport = new RecordingTransport();
  transport.throwOnSend = true;

  // The supervisor awaits this between leases. If it could throw, an outage at
  // the notification provider would fail work that already succeeded --
  // converting "we could not tell you" into "the work broke".
  await new TelegramRunNotifier(transport, "chat-1").taskFinished({
    taskId: "task-1",
    attemptOrdinal: 1,
    outcome: "succeeded",
  });

  assert.equal(transport.sent.length, 0);
});
