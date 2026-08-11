import assert from "node:assert/strict";
import test from "node:test";
import { TelegramApprovalUpdateHandler } from "../src/telegram/approval-handler.js";
import type {
  TelegramDecisionService,
  TelegramRequester,
} from "../src/telegram/gateway.js";

const TOKEN = "t".repeat(43);

class RecordingRequester implements TelegramRequester {
  readonly calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  failMethods = new Set<string>();
  async call(method: string, body: unknown) {
    if (this.failMethods.has(method)) throw new Error(`${method} unavailable`);
    this.calls.push({ method, body: body as Record<string, unknown> });
    return { ok: true };
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
  body(method: string) {
    return this.calls.find((c) => c.method === method)?.body;
  }
}

class RecordingDecisions implements TelegramDecisionService {
  readonly seen: Array<{ token: string; decision: string; userId: string }> =
    [];
  // The vocabulary ApprovalRepository.decide() actually returns:
  // "decided" | "replayed" | "expired" | "unauthorized" | "invalid".
  // An earlier version of this fake returned invented strings ("approved",
  // "already_decided"), so these tests passed while the real handler never
  // removed the buttons. Read src/approvals/postgres-repository.ts before
  // changing any value here.
  outcome = "decided";
  async decide(
    token: string,
    decision: "approved" | "denied",
    _chatId: string,
    userId: string,
  ) {
    this.seen.push({ token, decision, userId });
    return { outcome: this.outcome };
  }
}

const tap = (data: string) => ({
  update_id: 1,
  callback_query: {
    id: "cbq-1",
    data,
    message: { message_id: 55, chat: { id: 519 } },
    from: { id: 519 },
  },
});

const origin = { updateId: 1, chatId: "519", userId: "519" };

test("a tap records a real decision and clears the buttons", async () => {
  const requester = new RecordingRequester();
  const decisions = new RecordingDecisions();
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(
    tap(`approve:${TOKEN}`),
    origin,
  );

  assert.deepEqual(decisions.seen, [
    { token: TOKEN, decision: "approved", userId: "519" },
  ]);
  // Answering stops the button spinning; Telegram leaves it turning for ~30s
  // otherwise, which reads as "nothing happened" for something that did.
  assert.ok(requester.methods().includes("answerCallbackQuery"));
  // Buttons are removed so a decided approval stops looking actionable.
  const edit = requester.body("editMessageReplyMarkup");
  assert.deepEqual(edit?.reply_markup, { inline_keyboard: [] });
  assert.equal(edit?.message_id, 55);
});

test("a deny is recorded as a deny, not swallowed into approve", async () => {
  const requester = new RecordingRequester();
  const decisions = new RecordingDecisions();
  decisions.outcome = "decided";
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(
    tap(`deny:${TOKEN}`),
    origin,
  );
  assert.equal(decisions.seen[0]!.decision, "denied");
  // "decided" does not say which way, so the settled text comes from the button
  // the owner actually pressed. Showing "Approved" for a deny would be the
  // worst possible confusion in this surface.
  assert.equal(requester.body("answerCallbackQuery")?.text, "❌ Denied");
  assert.equal(requester.body("sendMessage")?.text, "❌ Denied");
  assert.deepEqual(requester.body("editMessageReplyMarkup")?.reply_markup, {
    inline_keyboard: [],
  });
});

test("an unknown outcome is never treated as a decision", async () => {
  const requester = new RecordingRequester();
  const decisions = new RecordingDecisions();
  decisions.outcome = "some_outcome_added_later";
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(
    tap(`approve:${TOKEN}`),
    origin,
  );

  // Only the literal "decided" clears the buttons. Anything this build does not
  // recognise must leave the approval looking undecided rather than silently
  // presenting itself as done.
  assert.equal(requester.methods().includes("editMessageReplyMarkup"), false);
  assert.equal(
    requester.body("answerCallbackQuery")?.text,
    "Recorded: some_outcome_added_later",
  );
});

test("a callback with a malformed token never reaches the decision service", async () => {
  const requester = new RecordingRequester();
  const decisions = new RecordingDecisions();
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(
    tap("approve:short"),
    origin,
  );

  // parseTelegramCallback refuses anything that is not approve|deny plus a
  // 43-character token, so a crafted callback cannot reach the decision at all.
  assert.deepEqual(decisions.seen, []);
  assert.ok(requester.methods().includes("answerCallbackQuery"));
  assert.equal(requester.methods().includes("editMessageReplyMarkup"), false);
});

test("an already-decided approval answers plainly and leaves the message alone", async () => {
  const requester = new RecordingRequester();
  const decisions = new RecordingDecisions();
  decisions.outcome = "replayed";
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(
    tap(`approve:${TOKEN}`),
    origin,
  );

  const answer = requester.body("answerCallbackQuery");
  assert.equal(answer?.text, "⚠️ Already decided");
  assert.equal(answer?.show_alert, true);
  // Only a real approve/deny rewrites the message. Editing on every outcome
  // would erase the buttons for an expiry the owner might still want to see.
  assert.equal(requester.methods().includes("editMessageReplyMarkup"), false);
});

test("a non-callback update is ignored rather than treated as an error", async () => {
  const requester = new RecordingRequester();
  const decisions = new RecordingDecisions();
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(
    { update_id: 2, message: { text: "hello", chat: { id: 519 } } },
    origin,
  );

  // Messages and commands belong to other handlers.
  assert.deepEqual(requester.calls, []);
  assert.deepEqual(decisions.seen, []);
});

test("a Telegram failure after the decision does not throw", async () => {
  const requester = new RecordingRequester();
  requester.failMethods.add("answerCallbackQuery");
  requester.failMethods.add("editMessageReplyMarkup");
  const decisions = new RecordingDecisions();

  // The decision is already durable at this point. Throwing here would make
  // the poller count a recorded approval as an unhandled update.
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(
    tap(`approve:${TOKEN}`),
    origin,
  );

  assert.deepEqual(decisions.seen, [
    { token: TOKEN, decision: "approved", userId: "519" },
  ]);
});

test("the tapping user's id is what reaches the decision, not the chat owner's", async () => {
  const requester = new RecordingRequester();
  const decisions = new RecordingDecisions();
  const update = {
    update_id: 3,
    callback_query: {
      id: "cbq-2",
      data: `approve:${TOKEN}`,
      message: { message_id: 9, chat: { id: 519 } },
      from: { id: 777 },
    },
  };
  await new TelegramApprovalUpdateHandler(requester, decisions).handle(update, {
    updateId: 3,
    chatId: "519",
    userId: "777",
  });

  // The repository authorises on this value. Passing the chat id instead would
  // let anyone in an authorised chat approve as the owner.
  assert.equal(decisions.seen[0]!.userId, "777");
});
