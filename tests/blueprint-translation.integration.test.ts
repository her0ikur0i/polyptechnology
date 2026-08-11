import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { OwnerCommandService } from "../src/operations/owner-commands.js";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { PostgresConversationStore } from "../src/orchestrator/postgres-store.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { queueBlueprintTranslation } from "../src/factory/blueprint-translation-task.js";
import { BlueprintTranslationDriver } from "../src/operations/blueprint-translation-driver.js";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import { ExecutableTaskSupervisor } from "../src/operations/execution-supervisor.js";
import type { OperationDriver } from "../src/operations/execution-supervisor.js";
import { AiGateway } from "../src/gateway/gateway.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import type {
  ManagedCompletion,
  ManagedProviderAdapter,
} from "../src/gateway/types.js";
import { runOwnTask } from "./run-own-task.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

class FakeExtractionClaude implements ManagedProviderAdapter {
  readonly provider = "claude" as const;
  constructor(private readonly content: string) {}
  async listModels() {
    return ["claude-sonnet-5"];
  }
  async invoke(): Promise<ManagedCompletion> {
    return {
      providerRequestId: randomUUID(),
      resolvedModelId: "claude-sonnet-5",
      resolutionSource: "provider_response",
      content: this.content,
      usage: {
        inputTokens: 30,
        outputTokens: 40,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 25,
      },
      modelUsage: [
        {
          resolvedModelId: "claude-sonnet-5",
          inputTokens: 30,
          outputTokens: 40,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 25,
        },
      ],
    };
  }
}

async function draftAndApprove(
  pool: pg.Pool,
  content: string,
): Promise<{
  projectId: string;
  projectVersion: number;
  contractCandidate: string;
}> {
  const conversations = new PostgresConversationStore(pool);
  const orchestrator = new OrchestratorService(conversations);
  const owner = new OwnerCommandService(
    new PostgresProjectFactory(pool),
    conversations,
    "x".repeat(40),
    orchestrator,
  );
  const context = {
    authenticated: true,
    actorId: "test-owner",
    csrfToken: "x".repeat(40),
  };
  const now = new Date().toISOString();
  const started = await owner.startConversation(context, {
    title: "Blueprint translation test",
    idempotencyKey: randomUUID(),
    occurredAt: now,
  });
  await owner.sendMessage(context, {
    projectId: started.projectId,
    conversationId: started.conversationId,
    content,
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    occurredAt: now,
  });
  const draft = await owner.draftProposal(context, {
    projectId: started.projectId,
    conversationId: started.conversationId,
    idempotencyKey: randomUUID(),
    occurredAt: now,
  });
  const handedOff = await owner.approveProposal(context, {
    projectId: started.projectId,
    proposalId: draft.proposalId,
    expectedVersion: draft.version,
  });
  const factory = new PostgresProjectFactory(pool);
  const project = await factory.getProject(started.projectId);
  if (!project) throw new Error("project missing after handoff");
  return {
    projectId: started.projectId,
    projectVersion: project.version,
    contractCandidate: handedOff.contractCandidate,
  };
}

test(
  "end-to-end: an approved proposal is translated into a real published blueprint and the project transitions to 'blueprint'",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const { projectId, projectVersion, contractCandidate } =
        await draftAndApprove(
          pool,
          "I want a Node/Express/Postgres tool to track vendor invoices for a small team.",
        );

      const queued = await queueBlueprintTranslation(pool, {
        projectId,
        proposalId: randomUUID(),
        contractCandidate,
        expectedProjectVersion: projectVersion,
      });

      const fakeContent = JSON.stringify({
        slug: "invoice-tracker",
        displayName: "Vendor Invoice Tracker",
        runtime: "node-22",
        framework: "express",
        database: "postgresql",
        requirements: ["Track vendor invoices", "Support a small team"],
      });
      const gateway = new AiGateway(new PostgresAttemptLedger(pool), [
        new FakeExtractionClaude(fakeContent),
      ]);
      const factory = new PostgresProjectFactory(pool);
      const driver = new BlueprintTranslationDriver(gateway, factory);
      const work = new PostgresWorkRepository(pool);
      const supervisor = new ExecutableTaskSupervisor(
        pool,
        work,
        new Map<string, OperationDriver>([["blueprint_translation", driver]]),
        "blueprint-translation-test",
        30_000,
      );

      const result = await runOwnTask(supervisor, queued.taskId);
      assert.equal(result?.task.id, queued.taskId);
      assert.equal(result?.task.state, "succeeded", JSON.stringify(result));

      const project = await factory.getProject(projectId);
      assert.ok(project);
      assert.equal(project!.state, "blueprint");

      const versionRow = await pool.query<{ document: unknown }>(
        "SELECT document FROM project_blueprint_versions WHERE id=$1",
        [project!.blueprintVersionId],
      );
      assert.equal(versionRow.rowCount, 1);
      const document = versionRow.rows[0]!.document as {
        displayName: string;
        stack: { runtime: string; framework: string; database: string };
        requirements: string[];
      };
      assert.equal(document.displayName, "Vendor Invoice Tracker");
      assert.equal(document.stack.runtime, "node-22");
      assert.equal(document.stack.framework, "express");
      assert.deepEqual(document.requirements, [
        "Track vendor invoices",
        "Support a small team",
      ]);
    } finally {
      await pool.end();
    }
  },
);

test(
  "a non-JSON model response fails closed (verified: false) instead of crashing the task",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const { projectId, projectVersion, contractCandidate } =
        await draftAndApprove(
          pool,
          "Something vague and unstructured about maybe building a thing.",
        );

      const queued = await queueBlueprintTranslation(pool, {
        projectId,
        proposalId: randomUUID(),
        contractCandidate,
        expectedProjectVersion: projectVersion,
      });

      const gateway = new AiGateway(new PostgresAttemptLedger(pool), [
        new FakeExtractionClaude("Sorry, I cannot help with that request."),
      ]);
      const factory = new PostgresProjectFactory(pool);
      const driver = new BlueprintTranslationDriver(gateway, factory);
      const work = new PostgresWorkRepository(pool);
      const supervisor = new ExecutableTaskSupervisor(
        pool,
        work,
        new Map<string, OperationDriver>([["blueprint_translation", driver]]),
        "blueprint-translation-failure-test",
        30_000,
      );

      const result = await runOwnTask(supervisor, queued.taskId);
      assert.equal(result?.task.id, queued.taskId);
      // Self-verifying failure: the task reaches a real terminal/retry
      // state through the supervisor's own outcome handling, not an
      // uncaught exception -- the project must stay untouched (still
      // "idea", not silently attached to garbage).
      assert.notEqual(result?.task.state, "succeeded");
      const project = await factory.getProject(projectId);
      assert.equal(project?.state, "idea");
    } finally {
      await pool.end();
    }
  },
);
