import { isAbsolute, posix } from "node:path";

// Single implementation of the repository-relative path guard that
// src/worker/planner.ts (as safeWorkerPath), src/work/git-publication.ts, and
// src/operations/patch-scope.ts each carried a private copy of until
// CONTRACT-015 M2. This is the boundary that stops an AI-authored diff from
// writing outside its declared scope, so three independently drifting copies
// meant a hardening fix could reach one call site and silently miss the other
// two.
//
// src/operations/patch-scope.ts previously documented its copy as a
// *deliberate* duplication, so that the boundary governing an untrusted
// AI-produced patch stayed independently reviewable from the one governing the
// final publication commit. That concern is preserved rather than overruled:
// what is shared here is the string-level primitive only. Every call site keeps
// its own wrapper, its own label, and its own tests, so the two trust
// boundaries are still reviewed separately at the point of use — they simply
// no longer disagree about what a dangerous path looks like.
//
// The checks below are the UNION of what the three implementations rejected,
// never the intersection:
//
// - empty input was rejected explicitly only by safeWorkerPath (the other two
//   caught it indirectly, since posix.normalize("") returns ".", which they
//   then rejected — same outcome by accident rather than by intent);
// - everything else was common to all three.
//
// The thrown message deliberately omits the offending path. safeWorkerPath was
// the only one of the three that already withheld it; the other two
// interpolated it. Since these paths arrive from untrusted model output and the
// resulting errors are logged and persisted as milestone evidence, the stricter
// posture is the correct union here — echoing attacker-controlled bytes,
// including newlines, into an evidence log is not worth the debugging
// convenience. Callers that need the value still have it in hand.

const GLOB_METACHARACTERS = /[*?[:]/;

// Bidirectional-override and zero-width characters. Not a traversal vector --
// the OS, git and posix.normalize all treat them as ordinary bytes -- but the
// same display-layer concern the NUL and newline handling already addresses:
// these paths come from untrusted model output and are later rendered into
// evidence files, terminals and diffs, where a right-to-left override makes a
// path read as something it is not. Added by the CONTRACT-015 M8 review.
// Written as escapes on purpose: the literal characters are invisible, so a
// class containing them is unreviewable and easy to corrupt in an editor.
const DECEPTIVE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export function safeRelativePath(path: string, label: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    DECEPTIVE_CHARACTERS.test(path) ||
    path.split(/[\\/]/).includes("..") ||
    GLOB_METACHARACTERS.test(path)
  )
    throw new Error(`unsafe ${label}`);

  const normalized = posix.normalize(path.replaceAll("\\", "/"));

  // Re-check absoluteness AFTER normalization, not only before it. All three
  // replaced implementations checked `isAbsolute` on the raw input only, which
  // a backslash defeats: "\\\\etc\\passwd" is not POSIX-absolute, but the
  // backslash-to-slash rewrite above turns it into "//etc/passwd" and
  // posix.normalize collapses the double slash to "/etc/passwd" -- an absolute
  // path returned from a function whose contract says it returns a relative
  // one. A caller doing resolve(root, result) would land outside the root,
  // because resolve() discards everything before an absolute segment.
  //
  // Not exploitable through any current call site (src/worker/artifacts.ts has
  // an independent realpath containment check, and the git-based callers hand
  // the raw patch to `git apply`, which does not treat backslashes as
  // separators). Fixed anyway: this is the shared primitive CLAUDE.md points
  // future callers at, and the only thing standing between this and a real
  // escape today is a check elsewhere that nothing documents as load-bearing.
  // Found by the CONTRACT-015 M8 independent review.
  if (normalized === "." || normalized === "./" || normalized.startsWith("/"))
    throw new Error(`unsafe ${label}`);
  if (normalized.startsWith("../")) throw new Error(`unsafe ${label}`);

  // Deliberately STRONGER than the union of the three implementations this
  // replaced. All three rejected ".git" and ".git/..." only at the root, so
  // "vendor/.git/config" and "a/.git/hooks/pre-commit" passed every one of
  // them. No legitimate source change writes inside any .git directory, at any
  // depth, so the segment is refused wherever it appears. Recorded as a
  // strengthening rather than a like-for-like merge because it is the one place
  // this module is not a faithful union — see
  // docs/contracts/CONTRACT-015/evidence/M2-unify-path-safety.md.
  // Case-folded. All three replaced implementations compared case-sensitively,
  // so ".GIT" and "vendor/.Git/config" passed every one of them. Harmless on
  // this deployment's case-sensitive Linux volumes, but the rule is stated as
  // "never inside a .git directory", and a rule that a capital letter defeats
  // is not that rule. Found by the CONTRACT-015 M8 independent review.
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git"))
    throw new Error(`unsafe ${label}`);

  return normalized;
}

// Scope-manifest matcher, previously duplicated verbatim as a private `owned`
// in both git-publication.ts and patch-scope.ts.
//
// A bare "**" entry returns false on purpose: a manifest that claims everything
// grants nothing, so a contract cannot accidentally hand an executor
// repository-wide write authority by writing the broadest possible pattern.
// This is intentionally stricter than scripts/verify-contract.ts's isOwnedPath,
// which does honour "**" — that tool reports on a human's working tree, while
// this one gates what a model is allowed to modify.
export function ownedByManifest(
  path: string,
  manifest: ReadonlyArray<string>,
): boolean {
  return manifest.some((entry) => {
    if (entry === "**") return false;
    return entry.endsWith("/**")
      ? entry.length > 3 && path.startsWith(entry.slice(0, -2))
      : path === entry;
  });
}
