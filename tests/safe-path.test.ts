import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute } from "node:path";
import { ownedByManifest, safeRelativePath } from "../src/safe-path.js";

const rejected = (path: string) =>
  assert.throws(
    () => safeRelativePath(path, "test path"),
    /unsafe test path/,
    `expected rejection: ${JSON.stringify(path)}`,
  );

test("safeRelativePath rejects traversal in every shape", () => {
  for (const path of [
    "../etc/passwd",
    "../../etc/passwd",
    "a/../../etc/passwd",
    "..",
    "a/..",
    "./../a",
    "a/b/../../../c",
    "..\\windows\\system32",
    "a\\..\\..\\b",
    // Refused even though it resolves back inside the root. The ".." segment
    // is rejected before normalization, so a non-escaping traversal is still
    // a rejection -- deliberately stricter than "does it escape?", and the
    // behaviour all three replaced implementations already had.
    "a/b/../c.ts",
  ])
    rejected(path);
});

test("safeRelativePath rejects absolute and drive-qualified paths", () => {
  // "C:\\..." is not absolute on POSIX; it is refused by the metacharacter
  // check instead, since ":" is a Git pathspec separator. Asserted explicitly
  // so a future relaxation of that character class cannot silently open it.
  for (const path of ["/etc/passwd", "/", "C:\\Windows", "C:/Windows"])
    rejected(path);
});

test("safeRelativePath rejects null bytes and empty input", () => {
  for (const path of ["", "\0", "a\0b", "src/\0", "a\0/../b"]) rejected(path);
});

test("safeRelativePath rejects Git pathspec and glob metacharacters", () => {
  for (const path of [
    "*",
    "src/*",
    "src/*.ts",
    "a?b",
    "[abc]",
    "src/[a-z].ts",
    ":(exclude)src",
    "a:b",
  ])
    rejected(path);
});

test("safeRelativePath refuses .git at any depth, not only the root", () => {
  // The three implementations this module replaced rejected only the first
  // two of these. The rest are the strengthening CONTRACT-015 M2 added.
  for (const path of [
    ".git",
    ".git/config",
    ".git/hooks/pre-commit",
    "vendor/.git",
    "vendor/.git/config",
    "a/b/.git/hooks/pre-commit",
    "packages/app/.git/objects/ff",
    "a/./.git/config",
  ])
    rejected(path);
});

test("safeRelativePath never returns an absolute path", () => {
  // The M8 review's headline path-guard finding: isAbsolute() ran on the raw
  // input only, and a backslash defeats it. "\\\\etc\\passwd" is not
  // POSIX-absolute, but the backslash rewrite turns it into "//etc/passwd" and
  // posix.normalize collapses that to "/etc/passwd" -- an absolute path
  // returned from a function contractually promising a relative one, which
  // resolve(root, result) would then honour by leaving the root entirely.
  for (const path of ["\\\\etc\\passwd", "\\\\\\etc\\passwd", "\\\\a\\b"])
    rejected(path);

  // The invariant behind that specific case, so the whole class stays closed
  // rather than just the one example.
  const corpus = [
    "src/index.ts",
    "./src/index.ts",
    "src//index.ts",
    "src\\worker\\planner.ts",
    ".github/workflows/quality.yml",
    ".gitignore",
    "a/b/c/d/e.ts",
    "\\src\\index.ts",
  ];
  for (const candidate of corpus) {
    let accepted: string | undefined;
    try {
      accepted = safeRelativePath(candidate, "test path");
    } catch {
      continue; // rejection is always a safe outcome
    }
    assert.equal(
      isAbsolute(accepted),
      false,
      `accepted an absolute result for ${JSON.stringify(candidate)}`,
    );
    assert.equal(accepted.startsWith("/"), false);
  }
});

test("safeRelativePath refuses .git regardless of case", () => {
  // All three replaced implementations compared case-sensitively, so a single
  // capital letter walked past the rule on any case-insensitive volume.
  for (const path of [
    ".GIT",
    ".Git",
    ".gIt/config",
    "vendor/.GIT/config",
    "a/b/.Git/hooks/pre-commit",
  ])
    rejected(path);
});

test("safeRelativePath rejects a bare current-directory reference", () => {
  // posix.normalize("./") returns "./", not ".", so it slipped past the
  // equality check that rejects ".". Every downstream caller happened to fail
  // safe by a different mechanism, which is not the same as the guard holding.
  rejected("./");
  rejected(".");
});

test("safeRelativePath rejects bidi and zero-width characters", () => {
  // Not traversal -- the OS and git treat these as ordinary bytes. The concern
  // is the same display-layer one the message-injection test already covers:
  // these paths are rendered into evidence files and terminals, where a
  // right-to-left override makes a path read as something it is not.
  for (const path of [
    "a/\u202egnp.exe/b",
    "src/\u200bindex.ts",
    "\ufeffsrc/index.ts",
    "a/\u2066b\u2069/c",
  ])
    rejected(path);
});

test("safeRelativePath accepts and normalizes ordinary repository paths", () => {
  assert.equal(safeRelativePath("src/index.ts", "test path"), "src/index.ts");
  assert.equal(safeRelativePath("./src/index.ts", "test path"), "src/index.ts");
  assert.equal(safeRelativePath("src//index.ts", "test path"), "src/index.ts");
  assert.equal(
    safeRelativePath("src\\worker\\planner.ts", "test path"),
    "src/worker/planner.ts",
  );
  assert.equal(safeRelativePath(".github", "test path"), ".github");
  assert.equal(
    safeRelativePath(".github/workflows/quality.yml", "test path"),
    ".github/workflows/quality.yml",
  );
  assert.equal(safeRelativePath(".gitignore", "test path"), ".gitignore");
});

test("safeRelativePath never echoes the offending path into its message", () => {
  // These errors are logged and persisted as milestone evidence, and the paths
  // arrive from untrusted model output. A path carrying newlines must not be
  // able to forge extra log lines.
  const forged = "a\n2026-01-01 FAKE LOG LINE\nb*";
  assert.throws(
    () => safeRelativePath(forged, "patch path"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "unsafe patch path");
      assert.ok(!error.message.includes("FAKE LOG LINE"));
      return true;
    },
  );
});

test("safeRelativePath labels the boundary that rejected the path", () => {
  assert.throws(
    () => safeRelativePath("../x", "worker path"),
    /unsafe worker path/,
  );
  assert.throws(
    () => safeRelativePath("../x", "repository path"),
    /unsafe repository path/,
  );
  assert.throws(
    () => safeRelativePath("../x", "patch path"),
    /unsafe patch path/,
  );
});

test("ownedByManifest matches exact entries and directory prefixes", () => {
  const manifest = ["src/dashboard/**", "package.json", "docs/product/**"];
  assert.equal(ownedByManifest("package.json", manifest), true);
  assert.equal(ownedByManifest("src/dashboard/app.tsx", manifest), true);
  assert.equal(ownedByManifest("src/dashboard/a/b/c.ts", manifest), true);
  assert.equal(ownedByManifest("docs/product/vision.md", manifest), true);

  assert.equal(ownedByManifest("package-lock.json", manifest), false);
  assert.equal(ownedByManifest("src/gateway/gateway.ts", manifest), false);
  assert.equal(ownedByManifest("src/dashboard", manifest), false);
});

test("ownedByManifest grants nothing for a bare ** manifest", () => {
  // A manifest that claims everything grants nothing, so a contract cannot
  // hand an executor repository-wide write authority by writing the broadest
  // possible pattern. Deliberately stricter than verify-contract.ts's
  // isOwnedPath, which reports on a human's working tree instead of gating a
  // model.
  assert.equal(ownedByManifest("src/gateway/gateway.ts", ["**"]), false);
  assert.equal(ownedByManifest("anything", ["**"]), false);
  assert.equal(ownedByManifest("src/a.ts", ["**", "src/a.ts"]), true);
});

test("ownedByManifest does not treat a prefix as a directory boundary", () => {
  // "src/dash/**" must not match "src/dashboard/app.tsx". The slice(0, -2)
  // leaves the trailing slash in place precisely to prevent this.
  assert.equal(
    ownedByManifest("src/dashboard/app.tsx", ["src/dash/**"]),
    false,
  );
  assert.equal(ownedByManifest("src/dash/app.tsx", ["src/dash/**"]), true);
});
