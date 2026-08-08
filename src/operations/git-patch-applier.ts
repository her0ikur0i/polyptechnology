import { spawn } from "node:child_process";
import type { PatchApplier } from "./ai-patch-driver.js";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runGit(
  args: ReadonlyArray<string>,
  cwd: string,
  stdin: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, stdio: "pipe" });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(stdin, "utf8");
  });
}

function parseChangedLines(numstatOutput: string): number {
  let total = 0;
  for (const line of numstatOutput.split("\n")) {
    const [added, removed] = line.split("\t");
    const addedCount = Number(added);
    const removedCount = Number(removed);
    if (Number.isSafeInteger(addedCount)) total += addedCount;
    if (Number.isSafeInteger(removedCount)) total += removedCount;
  }
  return total;
}

// Applies a unified diff to an isolated workspace via `git apply`. The
// workspace is expected to already be a git worktree (so git can resolve
// paths); this never touches the real repository -- callers are responsible
// for workspaceRoot being an isolated copy, and for having already run
// validatePatchScope() against the same patch before calling apply().
export class GitPatchApplier implements PatchApplier {
  async apply(
    workspaceRoot: string,
    patch: string,
  ): Promise<{ changedLines: number }> {
    const check = await runGit(
      ["apply", "--check", "--numstat", "-"],
      workspaceRoot,
      patch,
    );
    if (check.exitCode !== 0)
      throw new Error(
        `patch failed to apply cleanly: ${check.stderr.trim().slice(0, 500)}`,
      );
    const applied = await runGit(["apply", "-"], workspaceRoot, patch);
    if (applied.exitCode !== 0)
      throw new Error(
        `patch application failed: ${applied.stderr.trim().slice(0, 500)}`,
      );
    return { changedLines: parseChangedLines(check.stdout) };
  }
}
