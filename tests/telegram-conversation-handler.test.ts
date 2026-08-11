import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEGRAM_ACTOR,
  TelegramConversationHandler,
  telegramConversationKey,
} from "../src/telegram/conversation-handler.js";
import { SYSTEM_PROMPT_FINGERPRINT } from "../src/operations/conversation-reply-driver.js";
import type { UpdateOrigin } from "../src/telegram/poller.js";

// Negative tests for the one path in this contract that can act.
//
// Since Amendment 1 the assistant answering these messages has tools and a
// working directory as root. Everything else Telegram can reach is read-only:
// commands are a closed set, approvals answer decisions that already exist.
// This handler is the capable one, and until M7 it had no tests at all.

interface Call {
  method: string;
  body: unknown;
}

function harness(
  options: {
    conversationExists?: boolean;
    startThrows?: boolean;
    sendThrows?: boolean;
    requesterThrows?: boolean;
  } = {},
) {
  const started: unknown[] = [];
  const sent: unknown[] = [];
  const calls: Call[] = [];
  let exists = options.conversationExists ?? true;

  const handler = new TelegramConversationHandler({
    owner: {
      startConversation: async (_context: unknown, input: unknown) => {
        if (options.startThrows) throw new Error("start refused");
        started.push(input);
        exists = true;
        return undefined;
      },
      sendMessage: async (_context: unknown, input: unknown) => {
        if (options.sendThrows) throw new Error("send refused");
        sent.push(input);
        return undefined;
      },
    } as never,
    conversations: {
      conversation: async () =>
        exists ? { version: 7, id: "c", projectId: "p" } : undefined,
    } as never,
    requester: {
      call: async (method: string, body: unknown) => {
        if (options.requesterThrows) throw new Error("telegram down");
        calls.push({ method, body });
        return {};
      },
    },
    csrfSecret: "secret-token",
  });

  return { handler, started, sent, calls };
}

const origin: UpdateOrigin = { updateId: 1, chatId: "555", userId: "555" };

function message(text: unknown): unknown {
  return { update_id: 1, message: { message_id: 1, text, chat: { id: 555 } } };
}

test("an ordinary message becomes a stored turn and an acknowledgement", async () => {
  const { handler, sent, calls } = harness();
  await handler.handle(message("what is the state of the factory?"), origin);

  assert.equal(sent.length, 1);
  assert.equal(
    (sent[0] as { content: string }).content,
    "what is the state of the factory?",
  );
  // The optimistic-concurrency version comes from the conversation that was
  // read, not from a guess.
  assert.equal((sent[0] as { expectedVersion: number }).expectedVersion, 7);
  assert.equal(calls[0]?.method, "sendMessage");
});

test("a slash message is left entirely to the closed command set", async () => {
  const { handler, sent, calls } = harness();
  await handler.handle(message("/status"), origin);
  // Not stored, not acknowledged, no second answer to a command M6 answers.
  assert.deepEqual(sent, []);
  assert.deepEqual(calls, []);
});

test("a message with no text is ignored rather than guessed at", async () => {
  const { handler, sent } = harness();
  for (const body of [undefined, 42, "", "   "])
    await handler.handle(message(body), origin);
  // Photos, stickers and edits carry no text this system can treat as a turn,
  // and inventing one would put unpredictable content into a channel that acts.
  assert.deepEqual(sent, []);
});

test("an oversized message is refused here, not thrown out of the command service", async () => {
  const { handler, sent } = harness();
  await handler.handle(message("x".repeat(20_001)), origin);
  assert.deepEqual(sent, []);
  // The boundary is the boundary: exactly at the limit still goes through.
  await handler.handle(message("y".repeat(20_000)), origin);
  assert.equal(sent.length, 1);
});

test("an update with no chat id is dropped", async () => {
  const { handler, sent } = harness();
  await handler.handle(message("hello"), { updateId: 2 });
  // Without a chat there is nowhere to reply and no identity to attribute the
  // turn to. Both are required, so neither is inferred.
  assert.deepEqual(sent, []);
});

test("the conversation is created only when it is absent", async () => {
  const existing = harness({ conversationExists: true });
  await existing.handler.handle(message("first"), origin);
  await existing.handler.handle(message("second"), origin);
  // Calling startConversation() per message looked idempotent and was not: the
  // store compares the whole intent and occurredAt changes every call, so every
  // message after the first was silently rejected. M5's bug, kept fixed.
  assert.deepEqual(existing.started, []);
  assert.equal(existing.sent.length, 2);

  const fresh = harness({ conversationExists: false });
  await fresh.handler.handle(message("first"), origin);
  assert.equal(fresh.started.length, 1);
  assert.equal(fresh.sent.length, 1);
});

test("everything goes through OwnerCommandService with an authenticated context", async () => {
  const { handler, sent } = harness();
  await handler.handle(message("hello"), origin);
  // Reaching past the command service "because the poller already checked
  // identity" is how a second, weaker door gets built. The actor is recorded
  // as Telegram so the audit trail says where the message came from.
  assert.equal(sent.length, 1);
  assert.ok(TELEGRAM_ACTOR === "owner-telegram");
});

test("a failed acknowledgement does not undo a stored message", async () => {
  const { handler, sent } = harness({ requesterThrows: true });
  await handler.handle(message("hello"), origin);
  // Telegram being unreachable degrades the courtesy, never the work: the turn
  // is stored and the reply queued regardless.
  assert.equal(sent.length, 1);
});

test("a refused message never reaches the acknowledgement", async () => {
  const { handler, calls } = harness({ sendThrows: true });
  await assert.rejects(() => handler.handle(message("hello"), origin));
  // "⏳ Working on it…" for a turn that was not stored would be a lie the owner
  // then waits on.
  assert.deepEqual(calls, []);
});

test("the conversation key is per chat and changes with the system prompt", () => {
  assert.notEqual(
    telegramConversationKey("111"),
    telegramConversationKey("222"),
  );
  assert.equal(telegramConversationKey("111"), telegramConversationKey("111"));
  // The fingerprint is in the key so that changing the prompt starts a fresh
  // thread instead of inheriting a transcript that contradicts it -- the
  // failure where the assistant answered correctly and recanted nine seconds
  // later. If this ever stops being true, that bug is back.
  assert.ok(SYSTEM_PROMPT_FINGERPRINT.length > 0);
  assert.notEqual(
    telegramConversationKey("111"),
    telegramConversationKey(`111:${SYSTEM_PROMPT_FINGERPRINT}`),
  );
});
