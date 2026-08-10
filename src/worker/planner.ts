import { isAbsolute, relative, sep } from "node:path";
import type { WorkerCommand, WorkerJob } from "./types.js";
import { safeRelativePath } from "../safe-path.js";
const image = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
// Governs what an isolated worker may read or write inside its workspace.
// Shares one implementation with the publication and patch-scope boundaries
// (src/safe-path.ts) while keeping its own label and tests.
export const safeWorkerPath = (path: string): string =>
  safeRelativePath(path, "worker path");
export function planWorker(job: WorkerJob): WorkerCommand {
  if (
    !isAbsolute(job.isolationRoot) ||
    !isAbsolute(job.workspaceRoot) ||
    /[,\0\r\n]/.test(job.isolationRoot) ||
    /[,\0\r\n]/.test(job.workspaceRoot) ||
    job.workspaceRoot === job.isolationRoot ||
    relative(job.isolationRoot, job.workspaceRoot).startsWith(`..${sep}`) ||
    relative(job.isolationRoot, job.workspaceRoot) === ".." ||
    !image.test(job.image) ||
    job.command.length === 0 ||
    job.command.includes("\0") ||
    job.command === "git" ||
    job.args.some((arg) => arg.includes("\0")) ||
    !Number.isSafeInteger(job.timeoutMs) ||
    job.timeoutMs < 1 ||
    !Number.isSafeInteger(job.outputByteLimit) ||
    job.outputByteLimit < 1 ||
    !Number.isSafeInteger(job.memoryMb) ||
    job.memoryMb < 64 ||
    !Number.isFinite(job.cpuLimit) ||
    job.cpuLimit <= 0 ||
    job.cpuLimit > 2
  )
    throw new Error("invalid worker job");
  if (job.capabilities.has("secrets"))
    throw new Error("secret capability requires explicit future approval");
  const owned = job.ownedPaths.map(safeWorkerPath);
  if (owned.length === 0 || new Set(owned).size !== owned.length)
    throw new Error("invalid worker ownership");
  const environment = Object.entries(job.environment).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [key, value] of environment)
    if (!/^(CI|LANG|LC_ALL|NODE_ENV|TZ)$/.test(key) || value.includes("\0"))
      throw new Error("unsafe worker environment");
  const args = [
    "run",
    "--rm",
    "--init",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    `${job.memoryMb}m`,
    "--cpus",
    String(job.cpuLimit),
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    job.capabilities.has("network") ? "--network=bridge" : "--network=none",
    "--mount",
    `type=bind,src=${job.workspaceRoot},dst=/workspace`,
    "--workdir",
    "/workspace",
    ...environment.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--label",
    "polyp.worker.managed=true",
    job.image,
    job.command,
    ...job.args,
  ];
  return {
    executable: "docker",
    args,
    cwd: job.workspaceRoot,
    timeoutMs: job.timeoutMs,
    outputByteLimit: job.outputByteLimit,
  };
}
