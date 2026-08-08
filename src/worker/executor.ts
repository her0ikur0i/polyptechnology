import { collectArtifacts } from "./artifacts.js";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { planWorker } from "./planner.js";
import type { WorkerJob, WorkerRunResult, WorkerRunner } from "./types.js";
export async function executeWorker(
  job: WorkerJob,
  runner: WorkerRunner,
  signal?: AbortSignal,
): Promise<WorkerRunResult> {
  const isolationRoot = await realpath(job.isolationRoot),
    workspace = await realpath(job.workspaceRoot),
    scoped = relative(isolationRoot, workspace);
  if (scoped === "" || scoped === ".." || scoped.startsWith(`..${sep}`))
    throw new Error("workspace escaped isolation root");
  try {
    await lstat(join(workspace, ".git"));
    throw new Error("worker workspace contains Git metadata");
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ))
      throw error;
  }
  const command = planWorker(job),
    process = await runner.run(command, signal);
  const status = process.timedOut
    ? "timeout"
    : process.outputLimited
      ? "output_limited"
      : process.exitCode === 0
        ? "succeeded"
        : "failed";
  const artifacts =
    status === "succeeded"
      ? await collectArtifacts(
          job.workspaceRoot,
          job.ownedPaths,
          job.outputByteLimit,
        )
      : [];
  return { status, process, artifacts };
}
