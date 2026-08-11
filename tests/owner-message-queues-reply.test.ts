import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { OwnerCommandService } from "../src/operations/owner-commands.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import type {
  Conversation,
  ConversationStore,
  Message,
} from "../src/orchestrator/types.js";

// The guard that was missing when the Telegram path stored a message and never
// queued a reply. The sequence -- append, then queue -- used to live in the
// Express route, so only one caller could ever get it right, and the second
// caller failed silently while every existing test stayed green.
//
// This asserts the sequence belongs to the service, which is what makes it
// true for every caller rather than for whichever one the route serves.

// Not `implements ConversationStore`: the interface has a dozen members and
// this test exercises two of them. Claiming to implement it would mean writing
// ten stubs that assert nothing, and the cast at the injection point is the
// honest way to say "only these methods are reached here".
class StubStore {
  readonly appended: Message[] = [];
  conversationRow: Conversation = {
    id: randomUUID(),
    projectId: randomUUID(),
    title: "t",
    version: 3,
    createdAt: new Date(),
  };
  async createConversation(value: Conversation) {
    return value;
  }
  async appendMessage(value: Omit<Message, "ordinal">) {
    const message = { ...value, ordinal: this.appended.length + 1 } as Message;
    this.appended.push(message);
    return message;
  }
  async conversation() {
    return this.conversationRow;
  }
  async listConversations() {
    return [];
  }
  async renameConversation() {
    return this.conversationRow;
  }
  async setArchived() {
    return this.conversationRow;
  }
  async messages() {
    return this.appended;
  }
}

const CSRF = "c".repeat(40);
const context = {
  authenticated: true as const,
  actorId: "owner-test",
  csrfToken: CSRF,
};

function serviceWith(
  store: StubStore,
  queueReply?: (input: {
    conversationId: string;
    projectId: string;
    expectedVersion: number;
  }) => Promise<{ taskId: string }>,
) {
  return new OwnerCommandService(
    {} as never,
    store as unknown as ConversationStore,
    CSRF,
    new OrchestratorService(store as unknown as ConversationStore),
    queueReply,
  );
}

const command = (store: StubStore) => ({
  conversationId: store.conversationRow.id,
  projectId: store.conversationRow.projectId,
  content: "Test",
  idempotencyKey: randomUUID(),
  occurredAt: new Date().toISOString(),
  expectedVersion: 3,
});

test("sending a message queues its reply, for every caller", async () => {
  const store = new StubStore();
  const queued: Array<{ conversationId: string; expectedVersion: number }> = [];
  const service = serviceWith(store, async (input) => {
    queued.push(input);
    return { taskId: "task-1" };
  });

  const result = (await service.sendMessage(context, command(store))) as never;
  void result;

  assert.equal(store.appended.length, 1);
  assert.equal(
    queued.length,
    1,
    "a stored message with no queued reply is the bug",
  );
  assert.equal(queued[0]!.conversationId, store.conversationRow.id);
  // The owner's message is now in the thread, so the reply expects the next
  // version. Passing the pre-append value would fail the reply closed.
  assert.equal(queued[0]!.expectedVersion, 4);
});

test("the reply task id is returned to the caller", async () => {
  const store = new StubStore();
  const service = serviceWith(store, async () => ({ taskId: "task-42" }));
  const result = (await service.sendMessage(context, command(store))) as {
    replyTaskId?: string;
  };
  assert.equal(result.replyTaskId, "task-42");
});

test("no reply is queued if the append fails", async () => {
  const store = new StubStore();
  store.appendMessage = async () => {
    throw new Error("version conflict");
  };
  let queued = 0;
  const service = serviceWith(store, async () => {
    queued += 1;
    return { taskId: "task-1" };
  });

  await assert.rejects(service.sendMessage(context, command(store)));
  // Replying to a message that was never stored would answer a question
  // nobody asked.
  assert.equal(queued, 0);
});

test("omitting the queue is a visible choice, not a silent failure", async () => {
  const store = new StubStore();
  const service = serviceWith(store);
  const result = (await service.sendMessage(context, command(store))) as {
    replyTaskId?: string;
  };
  // A caller that supplies no mechanism gets no reply and no replyTaskId --
  // which is at least legible, unlike the original bug where the sequence
  // simply was not there.
  assert.equal(result.replyTaskId, undefined);
  assert.equal(store.appended.length, 1);
});
