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

// Applies a unified diff to a workspace via `git apply`. The workspace must
// already be a git worktree, so git can resolve paths, and the caller must
// have run validatePatchScope() against the same patch first.
//
// `--recount` is not leniency for its own sake. Models write correct diff
// bodies and miscount the `@@ -0,0 +1,N @@` line totals above them, and git
// rejects the whole patch as "corrupt patch at line N" -- which was the single
// most common way a real generation attempt died. `--recount` derives the
// counts from the hunk body instead of trusting the header.
//
// It weakens nothing that matters: context lines must still match the file
// exactly, paths are still whatever the diff says, and the patch still has to
// survive validatePatchScope() before this runs and the full verification
// chain after it. What it removes is a purely clerical failure.
export class GitPatchApplier implements PatchApplier {
  // Discards everything not committed. `git clean -fd` deliberately omits
  // `-x`, so ignored paths survive -- node_modules is ignored and is expensive
  // to reinstall, and the verification sandbox is network-free so it cannot
  // reinstall anything anyway.
  async revert(workspaceRoot: string): Promise<void> {
    const reset = await runGit(["reset", "--hard", "HEAD"], workspaceRoot, "");
    if (reset.exitCode !== 0)
      throw new Error(
        `workspace reset failed: ${reset.stderr.trim().slice(0, 500)}`,
      );
    const clean = await runGit(["clean", "-fd"], workspaceRoot, "");
    if (clean.exitCode !== 0)
      throw new Error(
        `workspace clean failed: ${clean.stderr.trim().slice(0, 500)}`,
      );
  }

  async apply(
    workspaceRoot: string,
    patch: string,
  ): Promise<{ changedLines: number }> {
    const check = await runGit(
      ["apply", "--check", "--recount", "--numstat", "-"],
      workspaceRoot,
      patch,
    );
    if (check.exitCode !== 0)
      throw new Error(
        `patch failed to apply cleanly: ${check.stderr.trim().slice(0, 500)}`,
      );
    const applied = await runGit(
      ["apply", "--recount", "-"],
      workspaceRoot,
      patch,
    );
    if (applied.exitCode !== 0)
      throw new Error(
        `patch application failed: ${applied.stderr.trim().slice(0, 500)}`,
      );
    return { changedLines: parseChangedLines(check.stdout) };
  }
}
