import { isAbsolute, posix } from "node:path";

// Same path-safety posture as src/work/git-publication.ts's safePath/owned
// (traversal, null bytes, glob metacharacters, .git rejected) -- duplicated
// on purpose rather than imported, since git-publication.ts governs the
// final M10 commit and this module governs an untrusted AI-produced patch
// before it ever reaches a workspace; keeping them independently reviewable
// is worth the few duplicated lines.
function safePath(path: string): string {
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..") ||
    path.includes("\0") ||
    /[*?[:]/.test(path)
  )
    throw new Error(`unsafe patch path: ${path}`);
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  )
    throw new Error(`unsafe patch path: ${path}`);
  return normalized;
}

const owned = (path: string, manifest: ReadonlyArray<string>) =>
  manifest.some((entry) => {
    if (entry === "**") return false;
    return entry.endsWith("/**")
      ? entry.length > 3 && path.startsWith(entry.slice(0, -2))
      : path === entry;
  });

// Extracts the set of file paths a unified diff touches, from the
// "diff --git a/<path> b/<path>" header lines only -- deliberately ignores
// +++/--- lines (which can read "/dev/null" for adds/deletes and are easy to
// spoof) and hunk bodies. A patch with no diff --git headers is rejected as
// unparseable rather than silently treated as touching nothing.
export function patchTouchedPaths(patch: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  const headerPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(patch)) !== null) {
    paths.add(match[1]!);
    paths.add(match[2]!);
  }
  if (paths.size === 0) throw new Error("patch has no diff --git headers");
  return [...paths];
}

// Validates every path a patch touches against the contract's owned-paths
// manifest (docs/contracts/CONTRACT-*/contract.md "File ownership"). Throws
// on the first out-of-scope or unsafe path rather than applying anything --
// an AI-produced patch is untrusted input until this passes.
export function validatePatchScope(
  patch: string,
  ownedPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const touched = patchTouchedPaths(patch).map(safePath);
  const outside = touched.filter((path) => !owned(path, ownedPaths));
  if (outside.length > 0)
    throw new Error(`patch touches out-of-scope paths: ${outside.join(", ")}`);
  return touched;
}
