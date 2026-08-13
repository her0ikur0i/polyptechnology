import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test(
  "scaffold test script runs generated phase tests",
  { skip: !enabled },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "scaffold-gates-generated-"));
    try {
      const provisioner = new NodeWorkspaceProvisioner(root);
      const { repoPath } = await provisioner.provision(
        "8f14e45f-ceea-4167-a5d1-8ee1c0e0a0a2",
        blueprint,
      );

      mkdirSync(join(repoPath, "tests", "generated"), { recursive: true });
      writeFileSync(
        join(repoPath, "tests", "generated", "phase-contract.test.ts"),
        [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          "",
          'test("generated phase contract is executed", () => {',
          "  assert.equal(1 + 1, 2);",
          "});",
          "",
        ].join("\n"),
      );

      const testRun = await run("npm", ["test"], {
        cwd: repoPath,
        env: childEnv(),
      });
      const output = `${testRun.stdout}${testRun.stderr}`;
      assert.match(
        output,
        /# pass 2\b/,
        `expected scaffold and generated phase tests to run:\n${output}`,
      );
      assert.match(
        output,
        /# fail 0\b/,
        `generated phase tests failed:\n${output}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// polyp-sequence.service runs with NODE_ENV=production (sequence.env), and
// provision()'s npm install spreads `...process.env` into the child -- so
// this is the actual ambient environment every real, supervisor-driven
// provisioning runs under, not a synthetic edge case. Found in CONTRACT-017D
// M2: under it, `npm install` silently omitted every devDependency --
// typescript, prettier, @types/node, all of them, since the scaffold has no
// runtime "dependencies" at all -- leaving node_modules holding only an
// empty `@types` stub. Every subsequent `tsc --noEmit` in the verify sandbox
// then failed with a shell "not found", recorded as `verification_failed`
// and indistinguishable from a real rejection: a deep-drill run walked every
// escalation tier to claude-sonnet-5 on evidence that was never real.
test(
  "provisioning under NODE_ENV=production still installs devDependencies",
  { skip: !enabled },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "scaffold-gates-prod-"));
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const provisioner = new NodeWorkspaceProvisioner(root);
      const { repoPath } = await provisioner.provision(
        "8f14e45f-ceea-4167-a5d1-8ee1c0e0a0a1",
        blueprint,
      );
      const result = await run("npm", ["run", "typecheck"], {
        cwd: repoPath,
        env: childEnv(),
      }).catch((error: unknown) => error as Error & { stdout?: string });
      assert.ok(
        !(result instanceof Error),
        `scaffold provisioned under NODE_ENV=production failed \`npm run typecheck\` (devDependencies missing?):\n${
          (result as { stdout?: string; stderr?: string }).stdout ?? ""
        }${(result as { stderr?: string }).stderr ?? ""}`,
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
