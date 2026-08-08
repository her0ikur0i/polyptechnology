import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectArtifacts } from "../src/worker/artifacts.js";
import { executeWorker } from "../src/worker/executor.js";
import { planWorker } from "../src/worker/planner.js";
import type { WorkerJob, WorkerRunner } from "../src/worker/types.js";
const image = `node@sha256:${"a".repeat(64)}`;
const job = (root: string): WorkerJob => ({
  isolationRoot: "/tmp",
  workspaceRoot: root,
  image,
  command: "npm",
  args: ["test"],
  ownedPaths: ["result.txt"],
  capabilities: new Set(["process"]),
  timeoutMs: 10_000,
  outputByteLimit: 10_000,
  memoryMb: 256,
  cpuLimit: 1,
  environment: { CI: "true", TZ: "UTC" },
});
test("worker plan is shell-free hardened and network denied", () => {
  const plan = planWorker(job("/tmp/workspace"));
  assert.equal(plan.executable, "docker");
  assert.ok(plan.args.includes("no-new-privileges"));
  assert.ok(plan.args.includes("--network=none"));
  assert.ok(!plan.args.includes("--privileged"));
});
test("worker rejects mutable images traversal git secrets and unsafe environment", () => {
  assert.throws(
    () => planWorker({ ...job("/tmp/w"), image: "node:latest" }),
    /invalid/,
  );
  assert.throws(
    () => planWorker({ ...job("/tmp/w"), ownedPaths: ["../x"] }),
    /unsafe/,
  );
  assert.throws(
    () => planWorker({ ...job("/tmp/w"), command: "git" }),
    /invalid/,
  );
  assert.throws(
    () => planWorker({ ...job("/tmp/w"), capabilities: new Set(["secrets"]) }),
    /secret/,
  );
  assert.throws(
    () => planWorker({ ...job("/tmp/w"), environment: { LD_PRELOAD: "x" } }),
    /environment/,
  );
});
test("executor hashes declared artifacts and propagates bounded states", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyp-worker-"));
  await writeFile(join(root, "result.txt"), "safe");
  const runner: WorkerRunner = {
    run: async () => ({
      exitCode: 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      outputLimited: false,
    }),
  };
  const result = await executeWorker(
    { ...job(root), isolationRoot: tmpdir() },
    runner,
  );
  assert.equal(result.status, "succeeded");
  assert.match(result.artifacts[0]!.sha256, /^[a-f0-9]{64}$/);
});
test("artifact symlink escape fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyp-worker-"));
  await symlink("/etc/hosts", join(root, "result.txt"));
  await assert.rejects(
    collectArtifacts(root, ["result.txt"], 10_000),
    /escaped|symlink/,
  );
});
