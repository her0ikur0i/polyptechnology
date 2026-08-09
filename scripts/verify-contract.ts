import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const requiredSections = [
  "## Objective",
  "## Scope",
  "## Out of scope",
  "## Milestones",
  "## Acceptance",
  "## Rollback",
  "## File ownership",
] as const;

export function missingContractSections(content: string): string[] {
  return requiredSections.filter((heading) => !content.includes(heading));
}

export function ownershipManifest(content: string): string[] {
  const section =
    content.split("## File ownership\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
  return [...section.matchAll(/^- `([^`]+)`$/gm)]
    .map((match) => match[1])
    .filter((path): path is string => path !== undefined);
}

export function isOwnedPath(
  path: string,
  manifest: readonly string[],
): boolean {
  return manifest.some((entry) =>
    entry.endsWith("/**")
      ? path.startsWith(entry.slice(0, -2))
      : path === entry,
  );
}

export function dirtyPaths(status: string): string[] {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3);
      const renamedPath = path.includes(" -> ")
        ? path.split(" -> ").at(-1)
        : path;
      return renamedPath ?? path;
    });
}

export function verifyContract(contractId = "CONTRACT-001"): void {
  const contractPath = resolve(`docs/contracts/${contractId}/contract.md`);
  const content = readFileSync(contractPath, "utf8");
  const missing = missingContractSections(content);
  if (missing.length > 0)
    throw new Error(`Contract ${contractId} is missing: ${missing.join(", ")}`);

  const manifest = ownershipManifest(content);
  if (manifest.length === 0)
    throw new Error(
      `Contract ${contractId} has an empty file ownership manifest`,
    );

  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  const outOfScope = dirtyPaths(status).filter(
    (path) => !isOwnedPath(path, manifest),
  );
  if (outOfScope.length > 0)
    throw new Error(
      `Contract ${contractId} has dirty out-of-scope paths: ${outOfScope.join(", ")}`,
    );

  console.log(`Contract ${contractId} structure and scope: OK`);
}

const invokedPath =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    verifyContract(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
