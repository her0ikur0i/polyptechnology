import { ownedByManifest, safeRelativePath } from "../safe-path.js";

// Governs an untrusted AI-produced patch before it ever reaches a workspace --
// the earliest and most exposed of the three boundaries that share
// src/safe-path.ts.
//
// This module previously kept a private copy of the guard on purpose, so that
// this boundary and src/work/git-publication.ts's could be reviewed
// independently. CONTRACT-015 M2 shares the string-level primitive but keeps
// the boundaries separate where it matters: each retains its own wrapper,
// label, and tests. The two are still reviewed apart; they just no longer
// disagree about what a dangerous path looks like, which is what three
// drifting copies eventually guaranteed they would.
const safePath = (path: string): string => safeRelativePath(path, "patch path");

const owned = ownedByManifest;

// Extracts the set of file paths a unified diff touches, from the
// "diff --git a/<path> b/<path>" header lines only -- deliberately ignores
// +++/--- lines (which can read "/dev/null" for adds/deletes and are easy to
// spoof) and hunk bodies. A patch with no diff --git headers is rejected as
// unparseable rather than silently treated as touching nothing.
// Pulls the unified diff out of whatever a provider actually answered with.
//
// The three registered providers do not speak identically. Some return a bare
// diff, some wrap it in a fence, and some put a short sentence first. Every
// one of those can be a correct answer to "give me a diff"; rejecting them
// before looking for the actual `diff --git` header made a whole fallback tier
// unusable because of presentation rather than substance.
//
// This is the same defect shape as the blueprint runtime that arrived as
// "node-22": a boundary that demands one exact form, fed by a model that had
// no way to know which form was meant. The fix belongs here, at the boundary,
// not in a prompt that hopes.
//
// Deliberately narrow. It finds where the diff starts and drops what precedes
// it; it never edits diff content, and a response with no `diff --git` header
// anywhere still fails exactly as before. Everything downstream --
// validatePatchScope, git apply, the sandboxed verification -- is unchanged.
export function extractUnifiedDiff(content: string): string {
  // A fenced block wins if one contains a diff: models put explanation
  // outside the fence and the answer inside it.
  const fencePattern = /```(?:diff|patch|)?\r?\n([\s\S]*?)```/g;
  let fence: RegExpExecArray | null;
  while ((fence = fencePattern.exec(content)) !== null) {
    const body = fence[1] ?? "";
    if (body.includes("diff --git ")) return trimToDiff(body);
  }
  return trimToDiff(content);
}

function trimToDiff(text: string): string {
  const start = text.indexOf("diff --git ");
  // No header at all: hand it back untouched so the caller reports the real
  // problem rather than an empty string.
  if (start === -1) return text;
  const trimmed = text.slice(start);
  // A trailing fence is the only thing that can follow the diff in a fenced
  // answer; anything else is left alone, since git tolerates trailing noise
  // far better than it tolerates a truncated hunk.
  const closing = trimmed.indexOf("\n```");
  const body = closing === -1 ? trimmed : trimmed.slice(0, closing + 1);
  // A unified diff must end with a newline, and models routinely strip the
  // trailing one -- chat APIs trim whitespace, and a diff is the one payload
  // where the final byte is load-bearing.
  //
  // git reports the omission as `corrupt patch at line <n+1>`, pointing one
  // past the last line, which reads like a truncated or malformed hunk and
  // sent this contract chasing prompt wording and `--recount` for two
  // milestones. It was one missing byte. The same captured diffs that git
  // called corrupt apply cleanly with a newline appended and nothing else
  // changed:
  //
  //   deepseek-v4-flash  corrupt at line 47  ->  4 0 src/index.ts
  //                                              27 1 tests/scaffold.test.ts
  //   deepseek-v4-pro    corrupt at line 58  ->  8 0 src/index.ts
  //                                              38 0 tests/slugify.test.ts
  return body.endsWith("\n") ? body : `${body}\n`;
}

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
//
// ownedPaths: "unscoped" is the explicit, narrow exception for a freshly
// scaffolded generated project (src/factory/generation-task.ts) -- it has
// no file-ownership manifest to check against because the whole repo *is*
// its scope. Safety checks (traversal, null bytes, .git) still apply; only
// the manifest-membership check is skipped, and only when the caller opted
// in by name rather than by passing a manifest that happens to match
// everything (the bare "**" string is deliberately never a wildcard here,
// matching src/work/git-publication.ts's own anti-footgun stance).
export function validatePatchScope(
  patch: string,
  ownedPaths: ReadonlyArray<string> | "unscoped",
): ReadonlyArray<string> {
  const touched = patchTouchedPaths(patch).map(safePath);
  if (ownedPaths === "unscoped") return touched;
  const outside = touched.filter((path) => !owned(path, ownedPaths));
  if (outside.length > 0)
    throw new Error(`patch touches out-of-scope paths: ${outside.join(", ")}`);
  return touched;
}
