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
import type { PatchApplier } from "../src/operations/ai-patch-driver.js";
import type { ProviderArtifactInput } from "../src/operations/provider-artifact-store.js";
import type { WorkerRunner, WorkerJob } from "../src/worker/types.js";

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
  readonly receivedMessages: ReadonlyArray<GatewayRequestMessage>[] = [];
  constructor(private readonly content: string) {}
  async listModels() {
    return ["deepseek-v4-pro", "deepseek-v4-flash"];
  }
  async invoke(
    route: ModelRoute,
    messages: ReadonlyArray<GatewayRequestMessage>,
  ): Promise<ManagedCompletion> {
    this.receivedMessages.push(messages);
    return {
      providerRequestId: "req-1",
      resolvedModelId: route.requestedModelId,
      resolutionSource: "provider_response",
      content: this.content,
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

type GatewayRequestMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const noopApplier: PatchApplier = {
  async apply() {
    return { changedLines: 2 };
  },
  async revert() {},
  async commit() {
    return "deadbeef";
  },
};

// Records whether the workspace was returned to its committed state, which is
// what stops a rejected patch becoming the baseline the next attempt patches
// on top of.
function recordingApplier() {
  const reverted: string[] = [];
  const applier: PatchApplier = {
    async apply() {
      return { changedLines: 2 };
    },
    async revert(workspaceRoot) {
      reverted.push(workspaceRoot);
    },
    async commit() {
      return "deadbeef";
    },
  };
  return { applier, reverted };
}

const noopCopier = { async copy() {} };

function workerRunner(exitCode: number): WorkerRunner {
  return {
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
  };
}

// Must match model-policy.ts's bulk_code[0] entry exactly. AiGateway compares
// routeOverride against modelRoutes(taskClass) by deep equality.
const route = modelRoutes("bulk_code")[0]!;

const gatewayRequest = {
  idempotencyKey: "contract011-task-1",
  taskClass: "bulk_code" as const,
  attribution: {
    projectId: "p",
    contractId: "CONTRACT-011",
    milestoneId: "M2",
    taskId: "t1",
    taskAttemptOrdinal: 1,
    agentId: "ai-patch-driver-test",
  },
  messages: [{ role: "user" as const, content: "bounded work" }],
  maxOutputTokens: 100,
  maxCostUsdMicros: 100,
  policyVersion: MODEL_POLICY_VERSION,
};

// executeWorker() calls realpath() on isolationRoot/workspaceRoot (both must
// exist and workspaceRoot must be strictly inside isolationRoot) and lstat on
// workspaceRoot/.git (must not exist) before running the command. Each call
// gets a fresh isolationRoot/workspaceRoot pair so tests never share or leak
// state between each other.
function realWorkspaceJob(): WorkerJob {
  const isolationRoot = mkdtempSync(join(tmpdir(), "patch-driver-"));
  const workspaceRoot = join(isolationRoot, "ws");
  mkdirSync(workspaceRoot);
  return {
    isolationRoot,
    workspaceRoot,
    image: "registry.invalid/img@sha256:" + "a".repeat(64),
    command: "npm",
    args: ["test"],
    // WorkerJob.ownedPaths is concrete artifact-output paths to collect
    // (see src/worker/artifacts.ts), not the contract-ownership glob
    // manifest -- unrelated to AiPatchTaskInput.ownedPaths below.
    ownedPaths: ["verification-report.json"],
    capabilities: new Set(),
    timeoutMs: 1000,
    outputByteLimit: 1000,
    memoryMb: 256,
    cpuLimit: 1,
    environment: {},
  };
}

test("accepted verification records an accepted artifact and 'none' decision", async () => {
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek(validPatch)]);
  const recorded: ProviderArtifactInput[] = [];
  const driver = new AiPatchExecutorDriver(
    gateway,
    noopApplier,
    workerRunner(0),
    {
      async record(input) {
        recorded.push(input);
      },
    },
    noopCopier,
  );
  const job = realWorkspaceJob();
  // A successful run declares (and collectArtifacts must find) the artifact
  // path it owns -- create it up front so this test exercises the driver's
  // accept path, not artifact collection itself (covered elsewhere).
  writeFileSync(join(job.workspaceRoot, "verification-report.json"), "{}");
  const result = await driver.run({
    taskId: "t1",
    gatewayRequest,
    route,
    ownedPaths: ["src/policy/**"],
    workspaceRoot: "/tmp",
    verifyJob: job,
    fallbackReason: null,
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.decision.action, "none");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.status, "accepted");
  assert.equal(recorded[0]?.changedLines, 2);
});
test("failed verification records a rejected artifact and escalates", async () => {
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek(validPatch)]);
  const recorded: ProviderArtifactInput[] = [];
  const driver = new AiPatchExecutorDriver(
    gateway,
    noopApplier,
    workerRunner(1),
    {
      async record(input) {
        recorded.push(input);
      },
    },
    noopCopier,
  );
  const result = await driver.run({
    taskId: "t1",
    gatewayRequest,
    route,
    ownedPaths: ["src/policy/**"],
    workspaceRoot: "/tmp",
    verifyJob: realWorkspaceJob(),
    fallbackReason: null,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.decision.action, "escalate");
  assert.equal(recorded[0]?.status, "rejected");
  assert.equal(recorded[0]?.patchSha256, null);
});

// A rejected patch used to stay applied to the project's real repository. The
// next attempt -- escalated to a different provider precisely because the
// first one failed -- would then build its diff against a tree already
// carrying that failure, `git apply` would fail on context, and a recoverable
// rejection would become a stuck task.
test("a rejected patch is reverted, so the next attempt starts from a clean tree", async () => {
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek(validPatch)]);
  const { applier, reverted } = recordingApplier();
  const driver = new AiPatchExecutorDriver(
    gateway,
    applier,
    workerRunner(1),
    { async record() {} },
    noopCopier,
  );
  const result = await driver.run({
    taskId: "t1",
    gatewayRequest,
    route,
    ownedPaths: ["src/policy/**"],
    workspaceRoot: "/tmp/project-repo",
    verifyJob: realWorkspaceJob(),
    fallbackReason: null,
  });
  assert.equal(result.status, "rejected");
  assert.deepEqual(reverted, ["/tmp/project-repo"]);
});

test("an accepted patch is left in place", async () => {
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek(validPatch)]);
  const { applier, reverted } = recordingApplier();
  const driver = new AiPatchExecutorDriver(
    gateway,
    applier,
    workerRunner(0),
    { async record() {} },
    noopCopier,
  );
  const job = realWorkspaceJob();
  // A successful run must find every artifact it declared.
  writeFileSync(join(job.workspaceRoot, "verification-report.json"), "{}");
  const result = await driver.run({
    taskId: "t1",
    gatewayRequest,
    route,
    ownedPaths: ["src/policy/**"],
    workspaceRoot: "/tmp/project-repo",
    verifyJob: job,
    fallbackReason: null,
  });
  assert.equal(result.status, "accepted");
  assert.deepEqual(reverted, []);
});

test("a patch outside the owned-paths manifest is rejected before verification runs", async () => {
  const outOfScopePatch = `diff --git a/src/dashboard/app.tsx b/src/dashboard/app.tsx
--- a/src/dashboard/app.tsx
+++ b/src/dashboard/app.tsx
@@ -1,1 +1,1 @@
-old
+new
`;
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [new FakeDeepSeek(outOfScopePatch)]);
  const recorded: ProviderArtifactInput[] = [];
  let workerCalled = false;
  const driver = new AiPatchExecutorDriver(
    gateway,
    noopApplier,
    {
      async run() {
        workerCalled = true;
        return workerRunner(0).run(undefined as never);
      },
    },
    {
      async record(input) {
        recorded.push(input);
      },
    },
    noopCopier,
  );
  const result = await driver.run({
    taskId: "t1",
    gatewayRequest,
    route,
    ownedPaths: ["src/policy/**"],
    workspaceRoot: "/tmp",
    verifyJob: realWorkspaceJob(),
    fallbackReason: null,
  });
  assert.equal(result.status, "rejected");
  assert.equal(
    workerCalled,
    false,
    "verification must not run for an out-of-scope patch",
  );
  assert.match(recorded[0]?.reason ?? "", /out-of-scope/);
});

test("DeepSeek patch attempts receive a strict diff-only output contract", async () => {
  const fake = new FakeDeepSeek(validPatch);
  const ledger = new MemoryAttemptLedger();
  const gateway = new AiGateway(ledger, [fake]);
  const driver = new AiPatchExecutorDriver(
    gateway,
    noopApplier,
    workerRunner(1),
    { async record() {} },
    noopCopier,
  );
  await driver.run({
    taskId: "t1",
    gatewayRequest,
    route,
    ownedPaths: ["src/policy/**"],
    workspaceRoot: "/tmp/project-repo",
    verifyJob: realWorkspaceJob(),
    fallbackReason: "patch has no diff --git headers",
  });
  const finalMessage = fake.receivedMessages[0]?.at(-1);
  assert.equal(finalMessage?.role, "user");
  assert.match(finalMessage?.content ?? "", /DEEPSEEK PATCH OUTPUT CONTRACT/);
  assert.match(
    finalMessage?.content ?? "",
    /first non-whitespace bytes.*`diff --git `/s,
  );
  assert.match(
    finalMessage?.content ?? "",
    /patch has no diff --git headers/,
  );
});
