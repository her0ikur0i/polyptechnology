import { spawn } from "node:child_process";
import type {
  WorkerCommand,
  WorkerProcessResult,
  WorkerRunner,
} from "./types.js";
export class SpawnWorkerRunner implements WorkerRunner {
  async run(
    command: WorkerCommand,
    signal?: AbortSignal,
  ): Promise<WorkerProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: { PATH: "/usr/bin:/bin" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let bytes = 0,
        timedOut = false,
        outputLimited = false,
        settled = false;
      const kill = () => {
        if (!child.killed) child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, command.timeoutMs);
      const abort = () => kill();
      signal?.addEventListener("abort", abort, { once: true });
      const capture = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > command.outputByteLimit) {
          outputLimited = true;
          kill();
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          timedOut,
          outputLimited,
        });
      });
    });
  }
}
