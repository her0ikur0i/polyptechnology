import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { safeWorkerPath } from "./planner.js";
import type { WorkerArtifact } from "./types.js";
export async function collectArtifacts(
  root: string,
  paths: ReadonlyArray<string>,
  maxBytes: number,
): Promise<ReadonlyArray<WorkerArtifact>> {
  const canonicalRoot = await realpath(root),
    artifacts: WorkerArtifact[] = [];
  let total = 0;
  for (const item of paths) {
    const relativePath = safeWorkerPath(item),
      candidate = resolve(canonicalRoot, relativePath),
      canonical = await realpath(candidate);
    if (
      relative(canonicalRoot, canonical).startsWith(`..${sep}`) ||
      relative(canonicalRoot, canonical) === ".."
    )
      throw new Error("artifact escaped workspace");
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error("artifact symlink denied");
    const handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`),
        openedRelative = relative(canonicalRoot, opened);
      if (openedRelative === ".." || openedRelative.startsWith(`..${sep}`))
        throw new Error("artifact escaped workspace");
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("artifact must be a file");
      total += metadata.size;
      if (total > maxBytes) throw new Error("artifact limit exceeded");
      const content = await handle.readFile();
      artifacts.push({
        relativePath,
        sizeBytes: metadata.size,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } finally {
      await handle.close();
    }
  }
  return artifacts;
}
