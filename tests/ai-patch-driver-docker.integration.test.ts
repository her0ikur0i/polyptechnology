import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiGateway } from "../src/gateway/gateway.js";
import { MemoryAttemptLedger } from "../src/gateway/memory-ledger.js";
import { MODEL_POLICY_VERSION } from "../src/gateway/model-policy.js";
import type {
  ManagedCompletion,
  ManagedProviderAdapter,
} from "../src/gateway/types.js";
import { AiPatchExecutorDriver } from "../src/operations/ai-patch-driver.js";
import { GitPatchApplier } from "../src/operations/git-patch-applier.js";
import { GitIgnoringWorkspaceCopier } from "../src/operations/workspace-copy.js";
import { SpawnWorkerRunner } from "../src/worker/spawn-runner.js";
import { verificationCommandFor } from "../src/operations/verification-image-policy.js";
import type { ProviderArtifactInput } from "../src/operations/provider-artifact-store.js";

// No TEST_WORKER_IMAGE gate here: this test pins its own image via
// verificationCommandFor(), the same policy production wiring uses -- it
// exercises the real end-to-end chain (real git apply, real Docker sandbox),
// not a substitute image, so it should run whenever Docker is available.
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

class FakeDeepSeek implements ManagedProviderAdapter {
  readonly provider = "deepseek" as const;
  constructor(private readonly content: string) {}
  async listModels() {
    return ["deepseek-v4-pro"];
  }
  async invoke(): Promise<ManagedCompletion> {
    return {
      providerRequestId: "req-1",
      resolvedModelId: "deepseek-v4-pro",
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
          resolvedModelId: "deepseek-v4-pro",
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

function initNpmRepo(testScriptExitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-patch-docker-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: {
        // The real verification command chains typecheck -> format:check ->
        // test (see verificationCommandFor); this fixture isn't a real TS
        // project, so the first two are harmless no-ops and only `test`
        // varies between the passing/failing cases these two e2e tests cover.
        typecheck: "true",
        "format:check": "true",
        test: `node -e "process.exit(${testScriptExitCode})"`,
      },
    }),
  );
  writeFileSync(join(dir, "file.txt"), "old\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const validPatch = `diff --git a/file.txt b/file.txt
index 5f76d61..e19e727 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
`;

const gatewayRequest = {
  idempotencyKey: "docker-e2e-1",
  taskClass: "bulk_code" as const,
  attribution: {
    projectId: "p",
    contractId: "CONTRACT-011",
    milestoneId: "M2",
    taskId: "t1",
    taskAttemptOrdinal: 1,
    agentId: "docker-e2e-test",
  },
  messages: [{ role: "user" as const, content: "bounded work" }],
  maxOutputTokens: 100,
  maxCostUsdMicros: 100,
  policyVersion: MODEL_POLICY_VERSION,
};

const route = {
  provider: "deepseek" as const,
  requestedModelId: "deepseek-v4-pro",
  role: "primary-executor",
  mode: "non-thinking" as const,
};

test(
  "end-to-end: real git apply + real Docker sandbox accepts a passing patch",
  { skip: !dockerAvailable },
  async () => {
    const dir = initNpmRepo(0);
    const ledger = new MemoryAttemptLedger();
    const gateway = new AiGateway(ledger, [new FakeDeepSeek(validPatch)]);
    const recorded: ProviderArtifactInput[] = [];
    const driver = new AiPatchExecutorDriver(
      gateway,
      new GitPatchApplier(),
      new SpawnWorkerRunner(),
      {
        async record(input) {
          recorded.push(input);
        },
      },
      new GitIgnoringWorkspaceCopier(),
    );
    const verify = verificationCommandFor("bulk_code");
    // Separate from `dir` (the git-apply target): executeWorker() refuses
    // any workspace containing .git, so verification runs against a
    // git-free copy the driver produces via WorkspaceCopier.
    const verifyDir = mkdtempSync(join(tmpdir(), "ai-patch-docker-verify-"));
    const result = await driver.run({
      taskId: "t1",
      gatewayRequest,
      route,
      ownedPaths: ["file.txt"],
      workspaceRoot: dir,
      verifyJob: {
        isolationRoot: tmpdir(),
        workspaceRoot: verifyDir,
        image: verify.image,
        command: verify.command,
        args: verify.args,
        ownedPaths: ["file.txt"],
        capabilities: new Set(),
        timeoutMs: 60_000,
        outputByteLimit: 100_000,
        memoryMb: 256,
        cpuLimit: 1,
        environment: { CI: "true" },
      },
      fallbackReason: null,
    });
    assert.equal(result.status, "accepted", JSON.stringify(recorded));
    assert.equal(recorded[0]?.status, "accepted");
  },
);

test(
  "end-to-end: a patch that applies but fails real verification is rejected and escalates",
  { skip: !dockerAvailable },
  async () => {
    const dir = initNpmRepo(1); // npm test always exits nonzero
    const ledger = new MemoryAttemptLedger();
    const gateway = new AiGateway(ledger, [new FakeDeepSeek(validPatch)]);
    const recorded: ProviderArtifactInput[] = [];
    const driver = new AiPatchExecutorDriver(
      gateway,
      new GitPatchApplier(),
      new SpawnWorkerRunner(),
      {
        async record(input) {
          recorded.push(input);
        },
      },
      new GitIgnoringWorkspaceCopier(),
    );
    const verify = verificationCommandFor("bulk_code");
    // Separate from `dir` (the git-apply target): executeWorker() refuses
    // any workspace containing .git, so verification runs against a
    // git-free copy the driver produces via WorkspaceCopier.
    const verifyDir = mkdtempSync(join(tmpdir(), "ai-patch-docker-verify-"));
    const result = await driver.run({
      taskId: "t1",
      gatewayRequest,
      route,
      ownedPaths: ["file.txt"],
      workspaceRoot: dir,
      verifyJob: {
        isolationRoot: tmpdir(),
        workspaceRoot: verifyDir,
        image: verify.image,
        command: verify.command,
        args: verify.args,
        ownedPaths: ["file.txt"],
        capabilities: new Set(),
        timeoutMs: 60_000,
        outputByteLimit: 100_000,
        memoryMb: 256,
        cpuLimit: 1,
        environment: { CI: "true" },
      },
      fallbackReason: null,
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.decision.action, "escalate");
  },
);
