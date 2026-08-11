import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdatePoller, originOf } from "../src/telegram/poller.js";
import type {
  TelegramUpdateHandler,
  UpdateOffsetStore,
  UpdateOrigin,
} from "../src/telegram/poller.js";
import type { TelegramRequester } from "../src/telegram/gateway.js";

class MemoryOffsets implements UpdateOffsetStore {
  constructor(public value = 0) {}
  async read() {
    return this.value;
  }
  async commit(offset: number) {
    this.value = Math.max(this.value, offset);
  }
}

class RecordingHandler implements TelegramUpdateHandler {
  readonly seen: UpdateOrigin[] = [];
  throwOn?: number;
  async handle(_update: unknown, origin: UpdateOrigin) {
    if (this.throwOn === origin.updateId) throw new Error("handler blew up");
    this.seen.push(origin);
  }
}

const requesterFor = (
  result: unknown[],
  onCall?: (body: Record<string, unknown>) => void,
): TelegramRequester => ({
  async call(_method, body) {
    onCall?.(body as Record<string, unknown>);
    return { ok: true, result };
  },
});

const message = (updateId: number, chatId: string, userId: string) => ({
  update_id: updateId,
  message: { chat: { id: chatId }, from: { id: userId }, text: "status" },
});

const callback = (updateId: number, chatId: string, userId: string) => ({
  update_id: updateId,
  callback_query: {
    data: `approve:${"t".repeat(43)}`,
    message: { chat: { id: chatId } },
    from: { id: userId },
  },
});

test("origin is read from a message and from a button tap alike", () => {
  assert.deepEqual(originOf(message(7, "519", "519")), {
    updateId: 7,
    chatId: "519",
    userId: "519",
  });
  // A callback carries chat on message.chat but the actor on callback.from --
  // reading the wrong one would authorise the wrong identity.
  assert.deepEqual(originOf(callback(8, "519", "777")), {
    updateId: 8,
    chatId: "519",
    userId: "777",
  });
  assert.equal(originOf({ no_update_id: true }), undefined);
  assert.equal(originOf(null), undefined);
});

test("numeric chat and user ids are compared as strings", () => {
  // Telegram sends these as numbers; configuration holds them as strings.
  assert.deepEqual(
    originOf({
      update_id: 1,
      message: { chat: { id: 519 }, from: { id: 519 } },
    }),
    {
      updateId: 1,
      chatId: "519",
      userId: "519",
    },
  );
});

test("an update from an unauthorized chat is refused before it is interpreted", async () => {
  const handler = new RecordingHandler();
  const poller = new TelegramUpdatePoller(
    requesterFor([message(1, "intruder", "519")]),
    new MemoryOffsets(),
    handler,
    ["519"],
    ["519"],
  );

  const outcome = await poller.pollOnce();
  assert.equal(outcome.refused, 1);
  assert.equal(outcome.handled, 0);
  // The handler is where content becomes meaning. It must never be reached.
  assert.deepEqual(handler.seen, []);
});

test("an empty allow-list refuses everything rather than accepting everything", async () => {
  const handler = new RecordingHandler();
  const poller = new TelegramUpdatePoller(
    requesterFor([message(1, "hello", "519")]),
    new MemoryOffsets(),
    handler,
    [],
    [],
  );

  // Unconfigured must not mean unrestricted. Found by M7's review of the
  // ingress: this class is the security boundary for a path that, since
  // Amendment 1, can change this repository as root, and it read its own
  // missing configuration as permission.
  assert.equal((await poller.pollOnce()).refused, 1);
  assert.deepEqual(handler.seen, []);
});

test("an update missing an identity is refused, not treated as anonymous", async () => {
  const handler = new RecordingHandler();
  const poller = new TelegramUpdatePoller(
    requesterFor([{ update_id: 1, message: { text: "hi" } }]),
    new MemoryOffsets(),
    handler,
    ["519"],
    ["519"],
  );

  assert.equal((await poller.pollOnce()).refused, 1);
  assert.deepEqual(handler.seen, []);
});

test("an update from an unauthorized user is refused even in the right chat", async () => {
  const handler = new RecordingHandler();
  const poller = new TelegramUpdatePoller(
    requesterFor([callback(1, "519", "someone-else")]),
    new MemoryOffsets(),
    handler,
    ["519"],
    ["519"],
  );

  assert.equal((await poller.pollOnce()).refused, 1);
  assert.deepEqual(handler.seen, []);
});

test("the offset is committed so a restart neither replays nor skips", async () => {
  const offsets = new MemoryOffsets();
  const handler = new RecordingHandler();
  const asked: Record<string, unknown>[] = [];
  const poller = new TelegramUpdatePoller(
    requesterFor([message(41, "519", "519"), message(42, "519", "519")], (b) =>
      asked.push(b),
    ),
    offsets,
    handler,
    ["519"],
    ["519"],
  );

  await poller.pollOnce();
  assert.equal(offsets.value, 42);
  // First call has no offset: a fresh install should receive whatever Telegram
  // still holds, including an approval sent during a deploy.
  assert.equal(asked[0]!.offset, undefined);

  await poller.pollOnce();
  // Telegram's offset means "acknowledge everything below this", so the next
  // request asks for one past the last handled id.
  assert.equal(asked[1]!.offset, 43);
});

test("the offset never moves backwards", async () => {
  const offsets = new MemoryOffsets(100);
  await offsets.commit(50);
  assert.equal(offsets.value, 100);
});

test("one failing update does not block the queue behind it", async () => {
  const offsets = new MemoryOffsets();
  const handler = new RecordingHandler();
  handler.throwOn = 2;
  const poller = new TelegramUpdatePoller(
    requesterFor([
      message(1, "519", "519"),
      message(2, "519", "519"),
      message(3, "519", "519"),
    ]),
    offsets,
    handler,
    ["519"],
    ["519"],
  );

  const outcome = await poller.pollOnce();
  assert.equal(outcome.handled, 2);
  assert.equal(outcome.failed, 1);
  // Retrying forever is how one malformed message stops every approval after
  // it. Approval tokens are single-use, so losing a handling is safe in the
  // direction that matters.
  assert.equal(offsets.value, 3);
});

test("a Telegram outage backs off instead of hammering the API", async () => {
  const failing: TelegramRequester = {
    async call() {
      throw new Error("telegram unreachable");
    },
  };
  const poller = new TelegramUpdatePoller(
    failing,
    new MemoryOffsets(),
    new RecordingHandler(),
    ["519"],
    ["519"],
    { backoffMs: 100, maxBackoffMs: 400 },
  );

  assert.equal((await poller.pollOnce()).failed, 1);
  assert.equal(poller.backoffMs, 100);
  await poller.pollOnce();
  assert.equal(poller.backoffMs, 200);
  await poller.pollOnce();
  assert.equal(poller.backoffMs, 400);
  await poller.pollOnce();
  assert.equal(poller.backoffMs, 400, "backoff must be capped");
});

test("backoff resets once Telegram answers again", async () => {
  let fail = true;
  const flaky: TelegramRequester = {
    async call() {
      if (fail) throw new Error("down");
      return { ok: true, result: [] };
    },
  };
  const poller = new TelegramUpdatePoller(
    flaky,
    new MemoryOffsets(),
    new RecordingHandler(),
    ["519"],
    ["519"],
    { backoffMs: 100 },
  );

  await poller.pollOnce();
  assert.equal(poller.backoffMs, 100);
  fail = false;
  await poller.pollOnce();
  assert.equal(poller.backoffMs, 0);
});

test("a malformed response is treated as a failure, not as an empty queue", async () => {
  const poller = new TelegramUpdatePoller(
    {
      async call() {
        return { ok: false, description: "bad token" };
      },
    },
    new MemoryOffsets(),
    new RecordingHandler(),
    ["519"],
    ["519"],
  );
  const outcome = await poller.pollOnce();
  // Reading `ok: false` as "nothing waiting" would hide a broken bot token
  // behind a permanently quiet channel.
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.received, 0);
});

test("an aborted signal stops the poll without calling Telegram", async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const poller = new TelegramUpdatePoller(
    {
      async call() {
        called = true;
        return { ok: true, result: [] };
      },
    },
    new MemoryOffsets(),
    new RecordingHandler(),
    ["519"],
    ["519"],
  );

  await poller.pollOnce(controller.signal);
  assert.equal(called, false);
});
