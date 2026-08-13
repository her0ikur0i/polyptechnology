import assert from "node:assert/strict";
import test from "node:test";
import { ConversationReplyDriver } from "../src/operations/conversation-reply-driver.js";
import type { ProviderSessionStore } from "../src/orchestrator/provider-sessions.js";

// What a turn sends, and what it remembers afterwards.
//
// Before CONTRACT-017A every turn replayed the entire thread. Cost grew with
// thread length, cache reads ran to six figures of tokens per turn, and a
// retry could never succeed because the transcript changed between attempts.

interface Captured {
  messages: ReadonlyArray<{ role: string; content: string }>;
  resumeSessionId?: string;
  idempotencyKey?: string;
  routeOverride?: unknown;
}

function harness(options: {
  session?: string;
  providerRequestId?: string;
  gatewayThrows?: boolean;
}) {
  const captured: Captured[] = [];
  const remembered: Array<[string, string, string]> = [];
  const forgotten: Array<[string, string]> = [];

  const gateway = {
    execute: async (request: {
      messages: ReadonlyArray<{ role: string; content: string }>;
      resumeSessionId?: string;
      idempotencyKey?: string;
      routeOverride?: unknown;
    }) => {
      if (options.gatewayThrows) throw new Error("session not found");
      captured.push({
        messages: request.messages,
        ...(request.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: request.resumeSessionId }),
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: request.idempotencyKey }),
        ...(request.routeOverride === undefined
          ? {}
          : { routeOverride: request.routeOverride }),
      });
      return {
        content: "the answer",
        attempt: {
          route: { provider: "deepseek" },
          ...(options.providerRequestId === undefined
            ? {}
            : { providerRequestId: options.providerRequestId }),
        },
      };
    },
  };

  const history = [
    { role: "owner", content: "first question", classification: "internal" },
    { role: "assistant", content: "first answer", classification: "internal" },
    { role: "owner", content: "second question", classification: "internal" },
  ];

  const appended: string[] = [];
  const conversations = {
    messages: async () => history,
    appendMessage: async (message: { id: string }) => {
      appended.push(message.id);
      return { id: message.id, version: 4 };
    },
  };

  const sessions: ProviderSessionStore = {
    find: async () => options.session,
    remember: async (conversationId, providerId, sessionId) => {
      remembered.push([conversationId, providerId, sessionId]);
    },
    forget: async (conversationId, providerId) => {
      forgotten.push([conversationId, providerId]);
    },
  };

  const driver = new ConversationReplyDriver(
    gateway as never,
    conversations as never,
    undefined,
    sessions,
  );
  return { driver, captured, remembered, forgotten, appended };
}

const INPUT = {
  projectId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  attribution: {
    taskId: "44444444-4444-4444-8444-444444444444",
    agentId: "a",
    projectId: "11111111-1111-4111-8111-111111111111",
    contractId: "55555555-5555-4555-8555-555555555555",
    milestoneId: "66666666-6666-4666-8666-666666666666",
    taskAttemptOrdinal: 1,
  },
  policyVersion: "2026-08-13.1",
  route: {
    provider: "claude",
    requestedModelId: "claude-sonnet-5",
    role: "orchestrator",
    effort: "medium",
  },
  expectedVersion: 3,
  maxOutputTokens: 4000,
  maxCostUsdMicros: 200000,
};

test("with no stored session the whole transcript is sent", async () => {
  const { driver, captured } = harness({});
  await driver.execute(INPUT, AbortSignal.timeout(5_000));

  const sent = captured[0]!;
  assert.equal(sent.resumeSessionId, undefined);
  // Two system messages plus all three history turns: the cold-start
  // behaviour, unchanged from before this contract.
  assert.equal(sent.messages.filter((m) => m.role !== "system").length, 3);
});

test("with a stored session only the new turn is sent, and it resumes", async () => {
  const { driver, captured } = harness({ session: "sess-live" });
  await driver.execute(INPUT, AbortSignal.timeout(5_000));

  const sent = captured[0]!;
  assert.equal(sent.resumeSessionId, "sess-live");
  const conversational = sent.messages.filter((m) => m.role !== "system");
  // The provider already holds everything before this; re-sending it is the
  // cost this contract exists to remove.
  assert.equal(conversational.length, 1);
  assert.equal(conversational[0]!.content, "second question");
});

test("the session the provider hands back is remembered against the conversation", async () => {
  const { driver, remembered } = harness({ providerRequestId: "sess-new" });
  await driver.execute(INPUT, AbortSignal.timeout(5_000));

  // The id has always been returned and always been stored on the attempt row.
  // Holding it against the *conversation* is the only new part.
  assert.deepEqual(remembered, [
    ["22222222-2222-4222-8222-222222222222", "deepseek", "sess-new"],
  ]);
});

test("a stored route snapshot is ignored so policy changes do not break replies", async () => {
  const { driver, captured } = harness({});
  await driver.execute(INPUT, AbortSignal.timeout(5_000));
  assert.equal(captured[0]!.routeOverride, undefined);
});

test("a provider that reports no session leaves nothing behind", async () => {
  const { driver, remembered } = harness({});
  await driver.execute(INPUT, AbortSignal.timeout(5_000));
  // No session recorded means the next turn replays — correct, and cheaper
  // than storing a value that cannot be resumed.
  assert.deepEqual(remembered, []);
});

test("a driver built without a session store behaves exactly as before", async () => {
  const captured: Captured[] = [];
  const gateway = {
    execute: async (request: Captured) => {
      captured.push(request);
      return { content: "answer", attempt: { providerRequestId: "s" } };
    },
  };
  const conversations = {
    messages: async () => [
      { role: "owner", content: "q", classification: "internal" },
    ],
    appendMessage: async () => ({ id: "m", version: 2 }),
  };

  // Continuity is an optimisation. A deployment without the store must still
  // answer, by replaying.
  const driver = new ConversationReplyDriver(
    gateway as never,
    conversations as never,
  );
  await driver.execute(INPUT, AbortSignal.timeout(5_000));
  assert.equal(captured[0]!.resumeSessionId, undefined);
});

test("a failed resume drops the session so the retry replays", async () => {
  const { driver, forgotten } = harness({
    session: "sess-expired",
    gatewayThrows: true,
  });

  await assert.rejects(() => driver.execute(INPUT, AbortSignal.timeout(5_000)));
  // Sessions expire and nothing announces it. Dropping the row is what makes
  // the work engine's own retry send the full transcript instead of asking
  // again for a session that no longer exists.
  assert.deepEqual(forgotten, [
    ["22222222-2222-4222-8222-222222222222", "deepseek"],
  ]);
});

test("a cold-start failure leaves no session to drop", async () => {
  const { driver, forgotten } = harness({ gatewayThrows: true });
  await assert.rejects(() => driver.execute(INPUT, AbortSignal.timeout(5_000)));
  // There was no resume, so the failure says nothing about any session.
  assert.deepEqual(forgotten, []);
});

test("each attempt is its own ledger entry, but the reply is not duplicated", async () => {
  const first = harness({});
  await first.driver.execute(INPUT, AbortSignal.timeout(5_000), {
    attemptOrdinal: 1,
  });
  const third = harness({});
  await third.driver.execute(INPUT, AbortSignal.timeout(5_000), {
    attemptOrdinal: 3,
  });

  // Attempt 1 keeps the original key, so nothing already in the ledger is
  // orphaned and a genuine duplicate delivery still deduplicates.
  assert.equal(
    first.captured[0]!.idempotencyKey,
    "33333333-3333-4333-8333-333333333333",
  );
  // A later attempt gets its own entry. Without this the ledger saw one key
  // with two different request hashes -- the transcript had grown -- and
  // refused the retry with `idempotency intent mismatch` before reserving
  // budget or reaching a provider.
  assert.equal(
    third.captured[0]!.idempotencyKey,
    "33333333-3333-4333-8333-333333333333#3",
  );

  // The appended message id must NOT vary by attempt: conversation-level
  // idempotency is what stops a retry adding a second assistant reply.
  assert.deepEqual(first.appended, third.appended);
});

test("a driver called with no context behaves as attempt one", async () => {
  const { driver, captured } = harness({});
  await driver.execute(INPUT, AbortSignal.timeout(5_000));
  assert.equal(
    captured[0]!.idempotencyKey,
    "33333333-3333-4333-8333-333333333333",
  );
});
