import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitIgnoringWorkspaceCopier } from "../src/operations/workspace-copy.js";

test("relative symlinks (like node_modules/.bin/tsc) resolve inside the copy, not back at the source", async () => {
  const source = mkdtempSync(join(tmpdir(), "workspace-copy-src-"));
  const destination = mkdtempSync(join(tmpdir(), "workspace-copy-dst-"));

  mkdirSync(join(source, "node_modules", "typescript", "bin"), {
    recursive: true,
  });
  writeFileSync(
    join(source, "node_modules", "typescript", "bin", "tsc"),
    "#!/usr/bin/env node\n",
  );
  mkdirSync(join(source, "node_modules", ".bin"), { recursive: true });
  symlinkSync(
    "../typescript/bin/tsc",
    join(source, "node_modules", ".bin", "tsc"),
  );

  await new GitIgnoringWorkspaceCopier().copy(source, destination);

  const copiedLink = join(destination, "node_modules", ".bin", "tsc");
  const target = readlinkSync(copiedLink);
  assert.equal(
    target,
    "../typescript/bin/tsc",
    "the symlink target string must stay relative, not get rewritten to the source's absolute path",
  );
});

test("still excludes .git from the copy", async () => {
  const source = mkdtempSync(join(tmpdir(), "workspace-copy-src-"));
  const destination = mkdtempSync(join(tmpdir(), "workspace-copy-dst-"));
  mkdirSync(join(source, ".git"), { recursive: true });
  writeFileSync(join(source, ".git", "config"), "");
  writeFileSync(join(source, "README.md"), "hi");

  await new GitIgnoringWorkspaceCopier().copy(source, destination);

  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(destination, ".git")), false);
  assert.equal(existsSync(join(destination, "README.md")), true);
});
