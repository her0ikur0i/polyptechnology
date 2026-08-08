import { isAbsolute, posix } from "node:path";
import type { ContractPublication } from "./types.js";
export interface Command {
  executable: "git";
  args: ReadonlyArray<string>;
  cwd: string;
}
export interface PublicationContext {
  repositoryPath: string;
  headSha: string;
  dirtyPaths: ReadonlyArray<string>;
  commitMessage: string;
  remote: string;
  branch: string;
}
function safePath(path: string): string {
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..") ||
    path.includes("\0") ||
    /[*?[:]/.test(path)
  )
    throw new Error(`unsafe repository path: ${path}`);
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  )
    throw new Error(`unsafe repository path: ${path}`);
  return normalized;
}
const owned = (path: string, manifest: ReadonlyArray<string>) =>
  manifest.some((entry) => {
    if (entry === "**") return false;
    return entry.endsWith("/**")
      ? entry.length > 3 && path.startsWith(entry.slice(0, -2))
      : path === entry;
  });
export function validateGitArguments(
  contract: ContractPublication,
  context: PublicationContext,
): void {
  if (!isAbsolute(context.repositoryPath))
    throw new Error("repository cwd must be absolute");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(contract.contractId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context.remote) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(context.branch) ||
    context.branch.includes("..") ||
    context.branch.includes("@{") ||
    context.branch.includes("//") ||
    context.branch.endsWith("/") ||
    context.commitMessage.includes("\0")
  )
    throw new Error("unsafe Git argument");
}
export function validateOwnedPaths(
  paths: ReadonlyArray<string>,
  manifest: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const normalized = paths.map(safePath);
  const outside = normalized.filter((path) => !owned(path, manifest));
  if (outside.length > 0)
    throw new Error(`dirty out-of-scope paths: ${outside.join(", ")}`);
  return normalized;
}
export function publicationPush(
  sha: string,
  context: PublicationContext,
): Command {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("invalid prepared commit SHA");
  return {
    executable: "git",
    args: ["push", context.remote, `${sha}:refs/heads/${context.branch}`],
    cwd: context.repositoryPath,
  };
}
export function publicationPlan(
  contract: ContractPublication,
  context: PublicationContext,
): ReadonlyArray<Command> {
  validateGitArguments(contract, context);
  if (contract.publishedSha !== undefined)
    throw new Error("contract already published");
  if (
    contract.preparedSha === undefined &&
    contract.baselineSha !== context.headSha
  )
    throw new Error("baseline drift");
  if (
    contract.preparedSha !== undefined &&
    contract.preparedSha !== context.headSha
  )
    throw new Error("prepared publication drift");
  if (
    contract.gates.length === 0 ||
    contract.gates.some((g) => !g.passed || g.evidenceIds.length === 0)
  )
    throw new Error("final gates incomplete");
  const paths = validateOwnedPaths(context.dirtyPaths, contract.ownedPaths);
  if (contract.preparedSha !== undefined)
    return [publicationPush(contract.preparedSha, context)];
  if (paths.length === 0) throw new Error("nothing to publish");
  return [
    {
      executable: "git",
      args: ["add", "--", ...paths],
      cwd: context.repositoryPath,
    },
    {
      executable: "git",
      args: [
        "commit",
        "--only",
        "-m",
        context.commitMessage,
        "-m",
        `Contract-ID: ${contract.contractId}`,
        "--",
        ...paths,
      ],
      cwd: context.repositoryPath,
    },
  ];
}
