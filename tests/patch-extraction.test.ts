import assert from "node:assert/strict";
import test from "node:test";
import {
  extractUnifiedDiff,
  patchTouchedPaths,
} from "../src/operations/patch-scope.js";

// The three registered providers do not present a diff the same way, and only
// one form was originally accepted. A fenced or prefaced diff is a correct
// answer wrapped differently, not a wrong one.

const diff = `diff --git a/src/slugify.ts b/src/slugify.ts
new file mode 100644
--- /dev/null
+++ b/src/slugify.ts
@@ -0,0 +1,3 @@
+export function slugify(input: string): string {
+  return input.toLowerCase();
+}
`;

test("a bare diff is returned unchanged", () => {
  assert.equal(extractUnifiedDiff(diff), diff);
});

test("a fenced diff is unwrapped", () => {
  const answer = "```diff\n" + diff + "```\n";
  assert.equal(extractUnifiedDiff(answer).trimEnd(), diff.trimEnd());
});

test("an unlabelled fence is unwrapped too", () => {
  const answer = "```\n" + diff + "```";
  assert.equal(extractUnifiedDiff(answer).trimEnd(), diff.trimEnd());
});

test("explanation before a fenced diff is dropped", () => {
  const answer =
    "Here is the patch. I created a new file rather than editing an\n" +
    "existing one, so it cannot conflict.\n\n```diff\n" +
    diff +
    "```\n\nLet me know if you want tests split out.";
  const extracted = extractUnifiedDiff(answer);
  assert.ok(extracted.startsWith("diff --git "), extracted.slice(0, 40));
  assert.ok(!extracted.includes("Let me know"));
  assert.deepEqual(patchTouchedPaths(extracted), ["src/slugify.ts"]);
});

test("explanation before an unfenced diff is dropped", () => {
  const extracted = extractUnifiedDiff(`Sure -- here is the diff:\n\n${diff}`);
  assert.ok(extracted.startsWith("diff --git "));
  assert.deepEqual(patchTouchedPaths(extracted), ["src/slugify.ts"]);
});

test("a prose fence that is not a diff does not shadow the real one", () => {
  const answer =
    "```ts\nexport const x = 1;\n```\n\n```diff\n" + diff + "```\n";
  const extracted = extractUnifiedDiff(answer);
  assert.ok(extracted.startsWith("diff --git "));
  assert.ok(!extracted.includes("export const x"));
});

// The narrowness is the point: this finds where a diff starts, it never
// repairs one. A response with no diff at all must still fail loudly.
test("a response with no diff is handed back untouched, and still fails", () => {
  const answer = "I could not complete this task.";
  assert.equal(extractUnifiedDiff(answer), answer);
  assert.throws(
    () => patchTouchedPaths(extractUnifiedDiff(answer)),
    /no diff --git headers/,
  );
});

test("diff content is never altered", () => {
  const answer = "Explanation.\n\n```diff\n" + diff + "```";
  assert.ok(
    extractUnifiedDiff(answer).includes(
      "+export function slugify(input: string): string {",
    ),
  );
});

// A unified diff must end with a newline. Chat APIs trim trailing whitespace,
// so models routinely return one without it, and git rejects the whole patch
// as `corrupt patch at line <n+1>` -- pointing one past the end, which reads
// like a truncated hunk. Two captured diffs that git called corrupt applied
// cleanly with nothing changed but this byte.
test("a diff missing its trailing newline gets one", () => {
  const stripped = diff.trimEnd();
  assert.ok(!stripped.endsWith("\n"));
  assert.ok(extractUnifiedDiff(stripped).endsWith("\n"));
});

test("a diff that already ends with a newline is not given a second", () => {
  assert.ok(diff.endsWith("\n"));
  assert.equal(extractUnifiedDiff(diff), diff);
});

test("a fenced diff missing its trailing newline gets one", () => {
  const answer = "Here you go:\n\n```diff\n" + diff.trimEnd() + "\n```";
  const extracted = extractUnifiedDiff(answer);
  assert.ok(extracted.startsWith("diff --git "));
  assert.ok(extracted.endsWith("\n"));
});
