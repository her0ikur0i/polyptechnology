import assert from "node:assert/strict";
import test from "node:test";
import type { AiGateway } from "../src/gateway/gateway.js";
import type { GatewayRequest } from "../src/gateway/types.js";
import type { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { BlueprintTranslationDriver } from "../src/operations/blueprint-translation-driver.js";

const input = {
  projectId: "project-1",
  contractCandidate: "Build a small verified project.",
  expectedProjectVersion: 1,
  idempotencyKey: "blueprint-translation-task-1",
  attribution: {
    projectId: "project-1",
    contractId: "contract-1",
    milestoneId: "milestone-1",
    taskId: "task-1",
    taskAttemptOrdinal: 1,
    agentId: "conversation-interview",
  },
  maxOutputTokens: 2_000,
  maxCostUsdMicros: 150_000,
  policyVersion: "2026-08-09.1",
  route: {
    provider: "deepseek" as const,
    requestedModelId: "deepseek-v4-flash",
    role: "orchestrator",
    mode: "non-thinking" as const,
  },
};

test("blueprint retries receive a distinct durable gateway identity", async () => {
  const keys: string[] = [];
  const routes: string[] = [];
  const gateway = {
    async execute(request: GatewayRequest) {
      keys.push(request.idempotencyKey);
      routes.push(
        `${request.routeOverride?.provider}:${request.routeOverride?.requestedModelId}`,
      );
      throw new Error("stop after observing request identity");
    },
  } as unknown as AiGateway;
  const driver = new BlueprintTranslationDriver(
    gateway,
    {} as PostgresProjectFactory,
  );

  await assert.rejects(
    driver.execute(input, new AbortController().signal, { attemptOrdinal: 1 }),
    /stop after observing/,
  );
  await assert.rejects(
    driver.execute(input, new AbortController().signal, { attemptOrdinal: 2 }),
    /stop after observing/,
  );
  await assert.rejects(
    driver.execute(input, new AbortController().signal, { attemptOrdinal: 3 }),
    /stop after observing/,
  );
  await assert.rejects(
    driver.execute(input, new AbortController().signal, { attemptOrdinal: 4 }),
    /stop after observing/,
  );
  await assert.rejects(
    driver.execute(input, new AbortController().signal, { attemptOrdinal: 5 }),
    /stop after observing/,
  );
  await assert.rejects(
    driver.execute(input, new AbortController().signal, { attemptOrdinal: 6 }),
    /stop after observing/,
  );

  assert.deepEqual(keys, [
    "blueprint-translation-task-1",
    "blueprint-translation-task-1#2",
    "blueprint-translation-task-1#3",
    "blueprint-translation-task-1#4",
    "blueprint-translation-task-1#5",
    "blueprint-translation-task-1#6",
  ]);
  assert.deepEqual(routes, [
    "deepseek:deepseek-v4-flash",
    "deepseek:deepseek-v4-pro",
    "codex:gpt-5.5",
    "codex:gpt-5.6",
    "claude:claude-sonnet-5",
    "claude:claude-opus-5",
  ]);
});
