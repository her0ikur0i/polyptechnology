import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeWorker } from "../src/worker/executor.js";
import { SpawnWorkerRunner } from "../src/worker/spawn-runner.js";
import { verificationCommandFor } from "../src/operations/verification-image-policy.js";

test("Docker worker runs without network capabilities or Git metadata and hashes artifacts", async () => {
  const image = verificationCommandFor("bulk_code").image;
  const root = await mkdtemp(join(tmpdir(), "polyp-isolated-worker-"));
  await writeFile(join(root, "result.txt"), "fixture");
  const result = await executeWorker(
    {
      isolationRoot: tmpdir(),
      workspaceRoot: root,
      image: image!,
      command: "node",
      args: ["--version"],
      ownedPaths: ["result.txt"],
      capabilities: new Set(["process"]),
      timeoutMs: 15_000,
      outputByteLimit: 10_000,
      memoryMb: 128,
      cpuLimit: 0.5,
      environment: { CI: "true", TZ: "UTC" },
    },
    new SpawnWorkerRunner(),
  );
  assert.equal(result.status, "succeeded", result.process.stderr.toString());
  assert.match(result.process.stdout.toString(), /^v22\./);
  assert.match(result.artifacts[0]!.sha256, /^[a-f0-9]{64}$/);
});
