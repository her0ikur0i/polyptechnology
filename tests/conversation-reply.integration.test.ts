import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { OwnerCommandService } from "../src/operations/owner-commands.js";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { PostgresConversationStore } from "../src/orchestrator/postgres-store.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { queueConversationReply } from "../src/orchestrator/reply-task.js";
import { ConversationReplyDriver } from "../src/operations/conversation-reply-driver.js";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import { ExecutableTaskSupervisor } from "../src/operations/execution-supervisor.js";
import type { OperationDriver } from "../src/operations/execution-supervisor.js";
import { AiGateway } from "../src/gateway/gateway.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import type {
  ManagedCompletion,
  ManagedProviderAdapter,
} from "../src/gateway/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

class FakeClaude implements ManagedProviderAdapter {
  readonly provider = "claude" as const;
  async listModels() {
    return ["claude-sonnet-5", "claude-opus-5"];
  }
  async invoke(): Promise<ManagedCompletion> {
    const content =
      "Got it -- to scope this well, what's the expected volume of invoices per month?";
    return {
      providerRequestId: randomUUID(),
      resolvedModelId: "claude-sonnet-5",
      resolutionSource: "provider_response",
      content,
      usage: {
        inputTokens: 40,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 15,
      },
      modelUsage: [
        {
          resolvedModelId: "claude-sonnet-5",
          inputTokens: 40,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 15,
        },
      ],
    };
  }
}

class CapturingFakeClaude implements ManagedProviderAdapter {
  readonly provider = "claude" as const;
  receivedMessages: ReadonlyArray<{ role: string; content: string }> = [];
  async listModels() {
    return ["claude-sonnet-5"];
  }
  async invoke(
    _route: unknown,
    messages: ReadonlyArray<{ role: string; content: string }>,
  ): Promise<ManagedCompletion> {
    this.receivedMessages = messages;
    return {
      providerRequestId: randomUUID(),
      resolvedModelId: "claude-sonnet-5",
      resolutionSource: "provider_response",
      content: "noted",
      usage: {
        inputTokens: 5,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 5,
      },
      modelUsage: [
        {
          resolvedModelId: "claude-sonnet-5",
          inputTokens: 5,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 5,
        },
      ],
    };
  }
}

test(
  "a secret-classified message is excluded from what the assistant ever sees",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const conversations = new PostgresConversationStore(pool);
      const owner = new OwnerCommandService(
        new PostgresProjectFactory(pool),
        conversations,
        "x".repeat(40),
        new OrchestratorService(conversations),
      );
      const context = {
        authenticated: true,
        actorId: "test-owner",
        csrfToken: "x".repeat(40),
      };
      const now = new Date().toISOString();

      const started = await owner.startConversation(context, {
        title: "Secret exclusion test",
        idempotencyKey: randomUUID(),
        occurredAt: now,
      });

      // sendMessage() always writes "internal" -- a secret-classified
      // message can only be constructed by writing to the store directly,
      // matching how classification is expected to eventually be set by a
      // future contract's real classification step, not by today's API.
      await conversations.appendMessage(
        {
          id: randomUUID(),
          conversationId: started.conversationId,
          projectId: started.projectId,
          role: "owner",
          content: "sk-do-not-let-the-model-see-this-fake-secret",
          classification: "secret",
          contentSha256: "0".repeat(64),
          createdAt: new Date(),
        },
        0,
        randomUUID(),
      );
      const sent = await owner.sendMessage(context, {
        projectId: started.projectId,
        conversationId: started.conversationId,
        content: "What's a reasonable next step?",
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        occurredAt: now,
      });

      const queued = await queueConversationReply(pool, {
        conversationId: started.conversationId,
        projectId: started.projectId,
        expectedVersion: sent.ordinal,
      });

      const fake = new CapturingFakeClaude();
      const gateway = new AiGateway(new PostgresAttemptLedger(pool), [fake]);
      const driver = new ConversationReplyDriver(gateway, conversations);
      const work = new PostgresWorkRepository(pool);
      const supervisor = new ExecutableTaskSupervisor(
        pool,
        work,
        new Map<string, OperationDriver>([["conversation_reply", driver]]),
        "conversation-reply-secret-test",
        30_000,
      );
      const result = await supervisor.runOne(new AbortController().signal);
      assert.equal(result?.task.id, queued.taskId);
      assert.equal(result?.task.state, "succeeded", JSON.stringify(result));

      const sawSecret = fake.receivedMessages.some((message) =>
        message.content.includes("do-not-let-the-model-see-this"),
      );
      assert.equal(sawSecret, false, JSON.stringify(fake.receivedMessages));
      const sawOwnerQuestion = fake.receivedMessages.some((message) =>
        message.content.includes("reasonable next step"),
      );
      assert.equal(sawOwnerQuestion, true);
    } finally {
      await pool.end();
    }
  },
);

test(
  "end-to-end: a real owner message reaches ConversationReplyDriver through the real supervisor and a real assistant reply is appended",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const conversations = new PostgresConversationStore(pool);
      const owner = new OwnerCommandService(
        new PostgresProjectFactory(pool),
        conversations,
        "x".repeat(40),
        new OrchestratorService(conversations),
      );
      const context = {
        authenticated: true,
        actorId: "test-owner",
        csrfToken: "x".repeat(40),
      };
      const now = new Date().toISOString();

      const started = await owner.startConversation(context, {
        title: "Invoice tracker idea",
        idempotencyKey: randomUUID(),
        occurredAt: now,
      });

      const sent = await owner.sendMessage(context, {
        projectId: started.projectId,
        conversationId: started.conversationId,
        content: "I want to track vendor invoices for a small team.",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        occurredAt: now,
      });

      const queued = await queueConversationReply(pool, {
        conversationId: started.conversationId,
        projectId: started.projectId,
        expectedVersion: sent.ordinal,
      });

      const gateway = new AiGateway(new PostgresAttemptLedger(pool), [
        new FakeClaude(),
      ]);
      const driver = new ConversationReplyDriver(gateway, conversations);
      const work = new PostgresWorkRepository(pool);
      const supervisor = new ExecutableTaskSupervisor(
        pool,
        work,
        new Map<string, OperationDriver>([["conversation_reply", driver]]),
        "conversation-reply-test",
        30_000,
      );

      const result = await supervisor.runOne(new AbortController().signal);
      assert.equal(result?.task.id, queued.taskId);
      assert.equal(result?.task.state, "succeeded", JSON.stringify(result));

      const messages = await conversations.messages(
        started.projectId,
        started.conversationId,
      );
      assert.equal(messages.length, 2);
      assert.equal(messages[0]!.role, "owner");
      assert.equal(messages[1]!.role, "assistant");
      assert.equal(messages[1]!.ordinal, 2);
      assert.match(messages[1]!.content, /invoices per month/);
    } finally {
      await pool.end();
    }
  },
);
