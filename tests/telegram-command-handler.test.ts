import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS,
  TelegramCommandHandler,
  TelegramCommandService,
  parseCommand,
  renderRefusal,
} from "../src/telegram/command-handler.js";
import type {
  ApprovalLine,
  BudgetAccountLine,
  CommandFacts,
  RunLine,
  StatusFacts,
} from "../src/telegram/command-facts.js";

const NOW = new Date("2026-08-10T12:00:00Z");

class StubFacts implements CommandFacts {
  constructor(
    private readonly data: {
      status?: StatusFacts;
      runs?: ReadonlyArray<RunLine>;
      approvals?: ReadonlyArray<ApprovalLine>;
      budget?: ReadonlyArray<BudgetAccountLine>;
      throwOn?: string;
    } = {},
  ) {}

  async status(): Promise<StatusFacts> {
    if (this.data.throwOn === "status") throw new Error("database is down");
    return this.data.status ?? { states: [], pendingApprovals: 0 };
  }
  async activeRuns(): Promise<ReadonlyArray<RunLine>> {
    return this.data.runs ?? [];
  }
  async pendingApprovals(): Promise<ReadonlyArray<ApprovalLine>> {
    return this.data.approvals ?? [];
  }
  async budget(): Promise<ReadonlyArray<BudgetAccountLine>> {
    return this.data.budget ?? [];
  }
}

function recorder() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    requester: {
      async call(method: string, body: unknown) {
        sent.push({ method, ...(body as Record<string, unknown>) });
        return {};
      },
    },
  };
}

test("the command set is closed: only the listed names parse", () => {
  for (const name of Object.keys(COMMANDS))
    assert.equal(parseCommand(`/${name}`), name);

  // Near misses are refused, not guessed at. "Did you mean" is how a closed set
  // stops being closed.
  for (const attempt of [
    "/statuses",
    "/stat",
    "/deploy",
    "/run",
    "/status; rm -rf /",
    "status",
    "",
  ])
    assert.equal(parseCommand(attempt), undefined);
});

test("a group-style /command@bot suffix parses and arguments are dropped", () => {
  assert.equal(parseCommand("/status@PolypTech_bot"), "status");
  assert.equal(parseCommand("/STATUS"), "status");
  // Arguments are not parsed at all -- accepting parameters would make the set
  // open in everything but name.
  assert.equal(parseCommand("/budget please raise the limit to 500"), "budget");
});

test("a refusal names what is available instead of only saying no", () => {
  const refusal = renderRefusal("/deploy production now");
  assert.ok(refusal.includes("Not a command"));
  for (const name of Object.keys(COMMANDS))
    assert.ok(refusal.includes(`/${name}`), `refusal should list /${name}`);
  // The attempt is echoed inside a code span, so a message containing "<" can
  // never break the send.
  assert.ok(refusal.includes("<code>/deploy production now</code>"));
});

test("an unknown command is refused and nothing is executed", async () => {
  const { sent, requester } = recorder();
  const handler = new TelegramCommandHandler({
    service: new TelegramCommandService(new StubFacts()),
    requester,
  });

  await handler.handle(
    { message: { text: "/deploy" } },
    { updateId: 1, chatId: "42", userId: "42" },
  );

  assert.equal(sent.length, 1);
  assert.ok(String(sent[0]?.text).includes("Not a command"));
});

test("plain conversation is left to the conversation handler", async () => {
  const { sent, requester } = recorder();
  const handler = new TelegramCommandHandler({
    service: new TelegramCommandService(new StubFacts()),
    requester,
  });

  await handler.handle(
    { message: { text: "berapa jumlah file .ts di src/telegram/?" } },
    { updateId: 1, chatId: "42", userId: "42" },
  );
  // A callback query is the approval handler's business, not this one's.
  await handler.handle(
    { callback_query: { data: "approve:abc" } },
    { updateId: 2, chatId: "42", userId: "42" },
  );

  assert.equal(sent.length, 0);
});

test("/status summarises work, approvals and budget in one message", async () => {
  const service = new TelegramCommandService(
    new StubFacts({
      status: {
        states: [
          { state: "running", count: 2 },
          { state: "queued", count: 1 },
        ],
        pendingApprovals: 1,
        budget: {
          scopeId: "default",
          spentUsdMicros: 770_120,
          reservedUsdMicros: 0,
          limitUsdMicros: 10_000_000,
        },
        lastFinishedAt: new Date("2026-08-10T11:30:00Z"),
      },
    }),
  );

  const text = await service.render("status", { now: NOW });
  assert.ok(text.startsWith("⏳ <b>3 active</b>"));
  assert.ok(text.includes("2 running · 1 queued"));
  assert.ok(text.includes("1 approval waiting"));
  assert.ok(text.includes("30 min ago"));
  // The budget line answers "how much is left", not "how much was spent":
  // remaining is the number that decides whether to start something now.
  assert.ok(text.includes("$9.23 left of $10.00"));
});

test("an idle factory says so rather than showing an empty running state", async () => {
  const text = await new TelegramCommandService(new StubFacts()).render(
    "status",
    { now: NOW },
  );
  assert.ok(text.startsWith("📦 <b>Idle</b>"));
  assert.ok(text.includes("no work in flight"));
  assert.ok(text.includes("no approvals waiting"));
});

test("/runs shows what is executing, /approvals what is waiting", async () => {
  const service = new TelegramCommandService(
    new StubFacts({
      runs: [
        {
          taskId: "0d5f3a9c-1111-4222-8333-444455556666",
          state: "running",
          driver: "ai_patch_executor",
          subject: "add the SSE resume route",
          attemptCount: 2,
          maxAttempts: 3,
          leasedBy: "polyp:1234",
          spentUsdMicros: 120_000,
        },
      ],
      approvals: [
        {
          id: "a1",
          summary: "Publish generated project to staging",
          risk: "medium",
          targetKind: "publication",
          expiresAt: new Date("2026-08-10T12:45:00Z"),
        },
      ],
    }),
  );

  const runs = await service.render("runs");
  assert.ok(runs.includes("1 active run"));
  // "Patch", not "ai_patch_executor": a driver id is an internal enum and the
  // owner reads these on a phone.
  assert.ok(runs.includes("Patch — running"));
  assert.ok(runs.includes("add the SSE resume route"));
  assert.ok(runs.includes("attempt 2/3"));
  assert.ok(runs.includes("polyp:1234"));
  assert.ok(runs.includes("$0.12"));
  // No id at all, not even a short one. The owner asked for work to be named
  // by what it is, and the subject line is what correlates a run to a report.
  assert.ok(!runs.includes("0d5f3a9c"));

  const approvals = await service.render("approvals", { now: NOW });
  assert.ok(approvals.includes("1 approval waiting"));
  assert.ok(approvals.includes("Publish generated project to staging"));
  assert.ok(approvals.includes("45 min left"));
  // No buttons. Tokens are single-use and identity-bound and are issued when an
  // approval is delivered; minting one because someone typed /approvals would
  // turn a read-only command into a way to create authority.
  assert.ok(!approvals.includes("callback_data"));
});

test("/budget counts reservations against what is left", async () => {
  const text = await new TelegramCommandService(
    new StubFacts({
      budget: [
        {
          scopeId: "default",
          spentUsdMicros: 4_000_000,
          reservedUsdMicros: 1_000_000,
          limitUsdMicros: 10_000_000,
        },
      ],
    }),
  ).render("budget");

  // 50%, not 40%: reserved money is committed and not spendable twice.
  assert.ok(text.includes("50%"));
  assert.ok(text.includes("$1.00 reserved"));
});

test("a failing query answers in the chat instead of throwing into the poller", async () => {
  const { sent, requester } = recorder();
  const handler = new TelegramCommandHandler({
    service: new TelegramCommandService(new StubFacts({ throwOn: "status" })),
    requester,
  });

  // Must not reject: the poller treats a thrown update as failed and advances
  // past it, so throwing here would look like silence to the owner.
  await handler.handle(
    { message: { text: "/status" } },
    { updateId: 1, chatId: "42", userId: "42" },
  );

  assert.equal(sent.length, 1);
  assert.ok(String(sent[0]?.text).includes("/status failed"));
  assert.ok(String(sent[0]?.text).includes("database is down"));
});

test("/runs stays one readable message however absurd the underlying data", async () => {
  const { sent, requester } = recorder();
  const handler = new TelegramCommandHandler({
    service: new TelegramCommandService(
      new StubFacts({
        runs: Array.from({ length: 10 }, (_, index) => ({
          taskId: `${index}`.repeat(8),
          state: "running",
          // Neither of these reaches the owner verbatim any more: the driver
          // becomes a human kind, and the subject is collapsed and bounded.
          // This test used to rely on the raw driver being echoed to force a
          // split, which is exactly the leak that was removed.
          driver: "x".repeat(600),
          subject: "y ".repeat(3_000),
          attemptCount: 1,
          maxAttempts: 3,
          spentUsdMicros: 0,
        })),
      }),
    ),
    requester,
  });

  await handler.handle(
    { message: { text: "/runs" } },
    { updateId: 1, chatId: "42", userId: "42" },
  );

  assert.equal(sent.length, 1, "ten runs should not need multiple messages");
  const text = String(sent[0]!.text);
  assert.ok(text.length <= 4_000, "within Telegram's limit");
  assert.ok(!text.includes("xxxxx"), "the raw driver id must not leak");
  for (const line of text.split("\n"))
    assert.ok(line.length < 200, `line stayed readable: ${line.slice(0, 40)}…`);
});
