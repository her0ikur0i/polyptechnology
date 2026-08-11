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
  assert.ok(text.includes("attempt 3"));
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
