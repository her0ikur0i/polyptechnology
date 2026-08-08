import assert from "node:assert/strict";
import test from "node:test";
import {
  patchTouchedPaths,
  validatePatchScope,
} from "../src/operations/patch-scope.js";

const twoFilePatch = `diff --git a/src/policy/types.ts b/src/policy/types.ts
index 1111111..2222222 100644
--- a/src/policy/types.ts
+++ b/src/policy/types.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/tests/policy-permission.test.ts b/tests/policy-permission.test.ts
index 3333333..4444444 100644
--- a/tests/policy-permission.test.ts
+++ b/tests/policy-permission.test.ts
@@ -1,1 +1,1 @@
-old
+new
`;

test("extracts touched paths from diff --git headers", () => {
  assert.deepEqual([...patchTouchedPaths(twoFilePatch)].sort(), [
    "src/policy/types.ts",
    "tests/policy-permission.test.ts",
  ]);
});

test("a patch with no diff --git headers is rejected", () => {
  assert.throws(() => patchTouchedPaths("not a patch"));
});

test("validatePatchScope passes when every path is owned", () => {
  const touched = validatePatchScope(twoFilePatch, [
    "src/policy/**",
    "tests/**",
  ]);
  assert.equal(touched.length, 2);
});

test("validatePatchScope rejects a patch touching an unowned path", () => {
  assert.throws(
    () => validatePatchScope(twoFilePatch, ["src/policy/**"]),
    /out-of-scope/,
  );
});

test("path traversal in a diff header is rejected", () => {
  const evil = `diff --git a/../../etc/passwd b/../../etc/passwd\n--- a/../../etc/passwd\n+++ b/../../etc/passwd\n`;
  assert.throws(() => validatePatchScope(evil, ["**"]));
});

test("a patch touching .git metadata is rejected", () => {
  const evil = `diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n`;
  assert.throws(() => validatePatchScope(evil, ["**"]));
});
