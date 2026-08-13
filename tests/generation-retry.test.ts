import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiGateway } from "../src/gateway/gateway.js";
import { MemoryAttemptLedger } from "../src/gateway/memory-ledger.js";
import {
  MODEL_POLICY_VERSION,
  modelRoutes,
} from "../src/gateway/model-policy.js";
import type {
  ManagedCompletion,
  ManagedProviderAdapter,
  ModelRoute,
} from "../src/gateway/types.js";
import { AiPatchExecutorDriver } from "../src/operations/ai-patch-driver.js";
import { AiPatchOperationDriver } from "../src/operations/ai-patch-operation-driver.js";
import type { PatchApplier } from "../src/operations/ai-patch-driver.js";
import type { WorkerRunner } from "../src/worker/types.js";

// A generation task's gateway idempotency key lives in
// `operation_task_specs.input`, which is immutable by trigger -- so every
// attempt of a task presented the same key. The gateway hashes the route into
// its request, which made both possible outcomes fatal:
//
//   same route      -> hash matches   -> "attempt already exists"
//   escalated route -> hash differs   -> "idempotency intent mismatch"
//
// Either way the retry died before reserving budget or calling a provider, so
// attempt 1 was the only attempt a generation task could ever make and
// `maxAttempts: 6` could never walk deepseek -> codex -> claude.
//
// CONTRACT-017A fixed exactly this for conversation replies and only there.

const validPatch = `diff --git a/src/policy/types.ts b/src/policy/types.ts
index 1111111..2222222 100644
--- a/src/policy/types.ts
+++ b/src/policy/types.ts
@@ -1,1 +1,1 @@
-old
+new
`;

class FakeDeepSeek implements ManagedProviderAdapter {
  readonly provider = "deepseek" as const;
  async listModels() {
    return ["deepseek-v4-pro", "deepseek-v4-flash"];
  }
  async invoke(route: ModelRoute): Promise<ManagedCompletion> {
    return {
      providerRequestId: "req-1",
      resolvedModelId: route.requestedModelId,
      resolutionSource: "provider_response",
      content: validPatch,
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 10,
      },
      modelUsage: [
        {
          resolvedModelId: route.requestedModelId,
          inputTokens: 5,
          outputTokens: 5,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 10,
        },
      ],
    };
  }
}

const applier: PatchApplier = {
  async apply() {
    return { changedLines: 2 };
  },
  async revert() {},
  async commit() {
    return "deadbeef";
  },
};

const runner = (exitCode: number): WorkerRunner => ({
  async run() {
    return {
      exitCode,
      signal: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      timedOut: false,
      outputLimited: false,
    };
  },
});

// executeWorker() resolves the workspace with realpath, so it must exist. The
// declared artifact is written up front so an accepted run exercises the
// driver's accept path rather than artifact collection.
function realVerifyJob() {
  const isolationRoot = mkdtempSync(join(tmpdir(), "generation-retry-"));
  const workspaceRoot = join(isolationRoot, "ws");
  mkdirSync(workspaceRoot);
  writeFileSync(join(workspaceRoot, "package.json"), "{}\n");
  return {
    isolationRoot,
    workspaceRoot,
    image: "registry.invalid/img@sha256:" + "a".repeat(64),
    command: "npm",
    args: ["test"],
    ownedPaths: ["package.json"],
    capabilities: [] as const,
    timeoutMs: 1000,
    outputByteLimit: 1000,
    memoryMb: 128,
    cpuLimit: 1,
    environment: {},
  };
}

function storedInput() {
  const route = modelRoutes("bulk_code")[0];
  assert.ok(route, "expected a static bulk_code route");
  return {
    taskId: "task-1",
    taskClass: "bulk_code",
    idempotencyKey: "generate-project-1",
    attribution: {
      projectId: "11111111-1111-4111-8111-111111111111",
      contractId: "22222222-2222-4222-8222-222222222222",
      milestoneId: "33333333-3333-4333-8333-333333333333",
      taskId: "task-1",
      taskAttemptOrdinal: 1,
      agentId: "factory-generation",
    },
    messages: [{ role: "user" as const, content: "scaffold it" }],
    maxOutputTokens: 100,
    maxCostUsdMicros: 1_000,
    policyVersion: MODEL_POLICY_VERSION,
    route,
    ownedPaths: "unscoped",
    workspaceRoot: "/tmp/project-repo",
    verifyJob: realVerifyJob(),
    fallbackReason: null,
  };
}

function driverFor(exitCode: number) {
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek()]);
  return new AiPatchOperationDriver(
    new AiPatchExecutorDriver(
      gateway,
      applier,
      runner(exitCode),
      { async record() {} },
      { async copy() {} },
    ),
  );
}

test("a second attempt reaches the provider instead of dying on the ledger", async () => {
  const driver = driverFor(1); // rejected, so the task would really be retried
  const input = storedInput();
  const controller = new AbortController();

  const first = await driver.execute(input, controller.signal, {
    attemptOrdinal: 1,
  });
  assert.equal((first as { status: string }).status, "rejected");

  // Before the fix this threw "attempt already exists" -- the same key with
  // the same route resolves to the first attempt's ledger row.
  const second = await driver.execute(input, controller.signal, {
    attemptOrdinal: 2,
  });
  assert.equal((second as { status: string }).status, "rejected");

  const third = await driver.execute(input, controller.signal, {
    attemptOrdinal: 3,
  });
  assert.equal((third as { status: string }).status, "rejected");
});

test("attempt 1 keeps the original key, so nothing already in the ledger is orphaned", async () => {
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek()]);
  const driver = new AiPatchOperationDriver(
    new AiPatchExecutorDriver(
      gateway,
      applier,
      runner(0),
      { async record() {} },
      { async copy() {} },
    ),
  );
  const input = storedInput();
  await driver.execute(input, new AbortController().signal, {
    attemptOrdinal: 1,
  });
  const found = await ledger.getByIdempotency("generate-project-1");
  assert.ok(found, "attempt 1 must use the unmodified stored key");
});

test("a driver given no context behaves as attempt 1", async () => {
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek()]);
  const driver = new AiPatchOperationDriver(
    new AiPatchExecutorDriver(
      gateway,
      applier,
      runner(0),
      { async record() {} },
      { async copy() {} },
    ),
  );
  await driver.execute(storedInput(), new AbortController().signal);
  assert.ok(await ledger.getByIdempotency("generate-project-1"));
});

test("an accepted patch advances the project lifecycle exactly once", async () => {
  const advanced: string[] = [];
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek()]);
  const driver = new AiPatchOperationDriver(
    new AiPatchExecutorDriver(
      gateway,
      applier,
      runner(0),
      { async record() {} },
      { async copy() {} },
    ),
    undefined,
    async ({ projectId }) => {
      advanced.push(projectId);
    },
  );
  await driver.execute(storedInput(), new AbortController().signal, {
    attemptOrdinal: 1,
  });
  assert.deepEqual(advanced, ["11111111-1111-4111-8111-111111111111"]);
});

test("a rejected patch does not advance the project lifecycle", async () => {
  const advanced: string[] = [];
  const driverWithHook = new AiPatchOperationDriver(
    new AiPatchExecutorDriver(
      new AiGateway(new MemoryAttemptLedger(), [new FakeDeepSeek()]),
      applier,
      runner(1),
      { async record() {} },
      { async copy() {} },
    ),
    undefined,
    async ({ projectId }) => {
      advanced.push(projectId);
    },
  );
  await driverWithHook.execute(storedInput(), new AbortController().signal, {
    attemptOrdinal: 1,
  });
  assert.deepEqual(advanced, []);
});
