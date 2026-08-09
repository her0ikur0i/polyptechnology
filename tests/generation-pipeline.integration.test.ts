import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { NodeWorkspaceProvisioner } from "../src/factory/workspace-provisioner.js";
import { createGenerationTask } from "../src/factory/generation-task.js";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import {
  ExecutableTaskSupervisor,
  type OperationDriver,
} from "../src/operations/execution-supervisor.js";
import { AiPatchExecutorDriver } from "../src/operations/ai-patch-driver.js";
import { AiPatchOperationDriver } from "../src/operations/ai-patch-operation-driver.js";
import { GitPatchApplier } from "../src/operations/git-patch-applier.js";
import { GitIgnoringWorkspaceCopier } from "../src/operations/workspace-copy.js";
import { PostgresProviderArtifactStore } from "../src/operations/provider-artifact-store.js";
import { PostgresPolicyRouteResolver } from "../src/operations/policy-route-resolver.js";
import { PostgresPolicyStore } from "../src/policy/postgres-policy-store.js";
import { SpawnWorkerRunner } from "../src/worker/spawn-runner.js";
import { AiGateway } from "../src/gateway/gateway.js";
import { PostgresAttemptLedger } from "../src/gateway/postgres-ledger.js";
import type {
  ManagedCompletion,
  ManagedProviderAdapter,
} from "../src/gateway/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
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
  async listModels() {
    return ["deepseek-v4-flash", "deepseek-v4-pro"];
  }
  async invoke(): Promise<ManagedCompletion> {
    const content = `diff --git a/src/greeting.ts b/src/greeting.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/greeting.ts
@@ -0,0 +1,3 @@
+export function greeting(): string {
+  return "hello from the generated project";
+}
`;
    return {
      providerRequestId: randomUUID(),
      resolvedModelId: "deepseek-v4-flash",
      resolutionSource: "provider_response",
      content,
      usage: {
        inputTokens: 50,
        outputTokens: 30,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 20,
      },
      modelUsage: [
        {
          resolvedModelId: "deepseek-v4-flash",
          inputTokens: 50,
          outputTokens: 30,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 20,
        },
      ],
    };
  }
}

test(
  "end-to-end: a real blueprint reaches AiPatchExecutorDriver through the real supervisor and gets a real patch applied",
  { skip: databaseUrl === undefined || !dockerAvailable },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const factory = new PostgresProjectFactory(pool);
      const now = new Date().toISOString();
      const blueprintId = randomUUID(),
        versionId = randomUUID(),
        projectId = randomUUID();
      const slug = `gen-pipeline-${randomUUID().slice(0, 8)}`;

      await factory.publishBlueprint({
        blueprintId,
        versionId,
        version: 1,
        createdAt: now,
        document: {
          schemaVersion: 1,
          slug,
          displayName: "Generation Pipeline Test",
          stack: { runtime: "node", framework: "none", database: "none" },
          requirements: ["Expose a greeting function"],
          qualityGates: ["typecheck", "test"],
          capabilities: ["workspace:write"],
          resources: {
            cpuMillis: 500,
            memoryMiB: 512,
            diskMiB: 1024,
            maxProcesses: 16,
            network: "none",
          },
          lifecyclePolicy: {
            productionApproval: true,
            destructiveApproval: true,
          },
        },
      });
      const project = await factory.createProject({
        id: projectId,
        slug,
        displayName: "Generation Pipeline Test",
        blueprintVersionId: versionId,
        createdAt: now,
      });

      const workspacesRoot = mkdtempSync(join(tmpdir(), "polyp-workspaces-"));
      const provisioner = new NodeWorkspaceProvisioner(workspacesRoot);
      const { repoPath } = await provisioner.provision(project.id, {
        schemaVersion: 1,
        slug,
        displayName: "Generation Pipeline Test",
        stack: { runtime: "node", framework: "none", database: "none" },
        requirements: ["Expose a greeting function"],
        qualityGates: ["typecheck", "test"],
        capabilities: ["workspace:write"],
        resources: {
          cpuMillis: 500,
          memoryMiB: 512,
          diskMiB: 1024,
          maxProcesses: 16,
          network: "none",
        },
        lifecyclePolicy: {
          productionApproval: true,
          destructiveApproval: true,
        },
      });
      assert.ok(existsGitDir(repoPath));

      const { taskId } = await createGenerationTask(
        pool,
        project,
        {
          schemaVersion: 1,
          slug,
          displayName: "Generation Pipeline Test",
          stack: { runtime: "node", framework: "none", database: "none" },
          requirements: ["Expose a greeting function"],
          qualityGates: ["typecheck", "test"],
          capabilities: ["workspace:write"],
          resources: {
            cpuMillis: 500,
            memoryMiB: 512,
            diskMiB: 1024,
            maxProcesses: 16,
            network: "none",
          },
          lifecyclePolicy: {
            productionApproval: true,
            destructiveApproval: true,
          },
        },
        repoPath,
      );

      const gateway = new AiGateway(new PostgresAttemptLedger(pool), [
        new FakeDeepSeek(),
      ]);
      const artifacts = new PostgresProviderArtifactStore(pool);
      const driver = new AiPatchOperationDriver(
        new AiPatchExecutorDriver(
          gateway,
          new GitPatchApplier(),
          new SpawnWorkerRunner(),
          artifacts,
          new GitIgnoringWorkspaceCopier(),
        ),
        new PostgresPolicyRouteResolver(
          new PostgresPolicyStore(pool),
          artifacts,
          gateway,
          "programming-routes",
        ),
      );

      const work = new PostgresWorkRepository(pool);
      const supervisor = new ExecutableTaskSupervisor(
        pool,
        work,
        new Map<string, OperationDriver>([["ai_patch_executor", driver]]),
        "generation-pipeline-test",
        30_000,
      );
      const result = await supervisor.runOne(new AbortController().signal);
      assert.equal(result?.task.id, taskId);
      assert.equal(result?.task.state, "succeeded", JSON.stringify(result));

      const recorded = await artifacts.forTask(taskId);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]?.status, "accepted");

      // git apply modifies the working tree directly (no --index, no
      // commit) -- read the file itself, not a committed ref.
      const greeting = readFileSync(
        join(repoPath, "src", "greeting.ts"),
        "utf8",
      );
      assert.match(greeting, /hello from the generated project/);
    } finally {
      await pool.end();
    }
  },
);

function existsGitDir(repoPath: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}
