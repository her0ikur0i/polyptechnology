import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Pushes a generated project's git repository to an owner-supplied remote in
// one shot. The remote URL is never persisted in the repository config, so a
// token embedded in an HTTPS URL does not outlive the single push. The URL is
// also never echoed back: the caller redacts it before returning anything.

export interface PushResult {
  // The commit SHA that was pushed (empty string if git did not report one).
  pushedSha: string;
  remoteRef: string;
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isSafeBranch(branch: string): boolean {
  return BRANCH_RE.test(branch) && branch.length <= 255 && branch !== "-";
}

// A remote must be a real transport, not a local filesystem path -- a
// filesystem "remote" would let a caller read or write arbitrary paths on the
// host through git's ref machinery.
export function isSafeRemoteUrl(remoteUrl: string): boolean {
  return (
    remoteUrl.length > 0 &&
    remoteUrl.length <= 2048 &&
    (/^https:\/\//i.test(remoteUrl) ||
      /^ssh:\/\//i.test(remoteUrl) ||
      /^git@/i.test(remoteUrl))
  );
}

export async function pushProjectRepository(
  repoPath: string,
  remoteUrl: string,
  branch: string,
): Promise<PushResult> {
  if (!isSafeBranch(branch)) throw new Error("invalid branch name");
  if (!isSafeRemoteUrl(remoteUrl)) throw new Error("invalid remote URL");

  const { stdout, stderr } = await execFileAsync(
    "git",
    ["-C", repoPath, "push", remoteUrl, `${branch}:refs/heads/${branch}`],
    { timeout: 120_000, maxBuffer: 1_048_576 },
  );

  const message = `${stdout}\n${stderr}`;
  // git reports "old..new  ref -> ref" for a created or updated branch; the
  // SHA after `..` is the one that landed.
  const match = message.match(/([0-9a-f]+)\.\.([0-9a-f]+)\s+\S+\s*->\s*(\S+)/);
  return {
    pushedSha: match?.[2] ?? "",
    remoteRef: match?.[3] ?? `refs/heads/${branch}`,
  };
}
