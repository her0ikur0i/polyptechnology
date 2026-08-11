import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { NodeWorkspaceProvisioner } from "../src/factory/workspace-provisioner.js";
import type { BlueprintDocument } from "../src/factory/types.js";

const run = promisify(execFile);

// The scaffold every generated project starts from must pass the exact
// verification chain its patches will be judged by.
//
// Nobody had ever run it. The first real provisioning produced a workspace
// whose own `typecheck` failed with TS18003 -- "no inputs were found" --
// because the scaffold contained no TypeScript at all, and whose `test`
// script globbed `tests/*.test.js` in a TypeScript project, matching nothing.
// `node --test` exits 0 when it matches no files, so verification would have
// reported a pass having run zero tests.
//
// Both defects have the same consequence: a perfectly good model patch is
// rejected, or a bad one accepted, for reasons that have nothing to do with
// the patch. This test exists so that can never be true again unnoticed.

const blueprint: BlueprintDocument = {
  schemaVersion: 1,
  slug: "scaffold-gate-check",
  displayName: "Scaffold Gate Check",
  stack: { runtime: "node", framework: "none", database: "none" },
  requirements: ["Exist", "Pass its own gates"],
  qualityGates: ["typecheck", "format:check", "test"],
  capabilities: [],
  resources: {
    cpuMillis: 500,
    memoryMiB: 1024,
    diskMiB: 4096,
    maxProcesses: 32,
    network: "none",
  },
  lifecyclePolicy: { productionApproval: true, destructiveApproval: true },
} as BlueprintDocument;

// Skipped without an explicit opt-in: it runs a real `npm install`, which
// needs the network and takes long enough that ordinary runs should not pay
// for it. Same reasoning as TEST_WORKER_IMAGE gating the Docker suite.
const enabled = process.env.TEST_SCAFFOLD_GATES === "enabled";

// The scaffold's own `npm test` is a nested `node --test`. Node detects the
// outer runner through NODE_TEST_CONTEXT and skips the inner one with a
// warning -- **exiting 0 while running nothing**, which is the exact false
// pass this test was written to catch. Stripping it makes the child a real,
// independent run.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "true" };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test(
  "a freshly provisioned scaffold passes typecheck, format:check and test",
  { skip: !enabled },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "scaffold-gates-"));
    try {
      const provisioner = new NodeWorkspaceProvisioner(root);
      const { repoPath } = await provisioner.provision(
        "8f14e45f-ceea-4167-a5d1-8ee1c0e0a0a0",
        blueprint,
      );

      for (const script of ["typecheck", "format:check", "test"]) {
        const result = await run("npm", ["run", script], {
          cwd: repoPath,
          env: childEnv(),
        }).catch((error: unknown) => error as Error & { stdout?: string });
        assert.ok(
          !(result instanceof Error),
          `scaffold failed \`npm run ${script}\`:\n${
            (result as { stdout?: string; stderr?: string }).stdout ?? ""
          }${(result as { stderr?: string }).stderr ?? ""}`,
        );
      }

      // `node --test` exits 0 when it matches no files, so a green exit code
      // alone does not prove anything ran. Assert a test actually executed.
      // Both streams are read: npm puts its own banner on stdout and the
      // runner's report does not reliably land on the same one.
      const testRun = await run("npm", ["test"], {
        cwd: repoPath,
        env: childEnv(),
      });
      const output = `${testRun.stdout}${testRun.stderr}`;
      assert.match(
        output,
        /# pass 1\b/,
        `expected exactly one scaffold test to run:\n${output}`,
      );
      assert.match(output, /# fail 0\b/, `scaffold tests failed:\n${output}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
