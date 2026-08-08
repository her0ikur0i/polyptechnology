import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitPatchApplier } from "../src/operations/git-patch-applier.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-patch-applier-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "old\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const validPatch = `diff --git a/file.txt b/file.txt
index 5f76d61..e19e727 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
`;

test("applies a valid patch and reports changed line count", async () => {
  const dir = initRepo();
  const applier = new GitPatchApplier();
  const result = await applier.apply(dir, validPatch);
  assert.equal(result.changedLines, 2); // 1 added + 1 removed
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "new\n");
});

test("a patch that does not apply cleanly throws and leaves the workspace untouched", async () => {
  const dir = initRepo();
  const applier = new GitPatchApplier();
  const badPatch = `diff --git a/file.txt b/file.txt
index 5f76d61..e19e727 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-this line does not exist
+new
`;
  await assert.rejects(() => applier.apply(dir, badPatch));
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "old\n");
});

test("a malformed patch throws", async () => {
  const dir = initRepo();
  const applier = new GitPatchApplier();
  await assert.rejects(() => applier.apply(dir, "not a real patch"));
});
