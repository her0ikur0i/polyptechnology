import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrettierWorkspaceFormatter } from "../src/operations/workspace-formatter.js";

// The formatter runs on the HOST, as root, over a workspace an untrusted model
// has just patched -- and it runs BEFORE the workspace is copied into the
// Docker sandbox. So none of `--read-only`, `--network=none` or
// `--cap-drop=ALL` protect this step. Whatever it executes, executes for real.
//
// The first version of this class ran `npx prettier --write .` inside that
// workspace, which was arbitrary code execution as root by two separate
// routes, both reachable because generation patches run `ownedPaths:
// "unscoped"`:
//
//   1. Prettier resolves config with cosmiconfig, which `require()`s
//      `.prettierrc.js` / `prettier.config.js`.
//   2. `npx` resolves `node_modules/.bin/prettier` from the workspace, and
//      `git apply` can create that path.
//
// These tests plant each attack and assert nothing runs. They are the reason
// to trust the step at all, so they execute the real formatter -- no fakes.

function sentinelConfig(sentinel: string): string {
  return [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "module.exports = {};",
  ].join("\n");
}

test("a .prettierrc.js planted by a patch is never executed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "formatter-safety-"));
  try {
    const sentinel = join(workspace, "PWNED");
    writeFileSync(join(workspace, ".prettierrc.js"), sentinelConfig(sentinel));
    // Something for the formatter to legitimately do, so the run is real.
    writeFileSync(join(workspace, "code.ts"), "export const x   =    1;\n");

    await new PrettierWorkspaceFormatter().format(workspace);

    assert.ok(
      !existsSync(sentinel),
      "prettier executed a config file the workspace supplied",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a prettier.config.cjs planted by a patch is never executed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "formatter-safety-"));
  try {
    const sentinel = join(workspace, "PWNED");
    writeFileSync(
      join(workspace, "prettier.config.cjs"),
      sentinelConfig(sentinel),
    );
    writeFileSync(join(workspace, "code.ts"), "export const x   =    1;\n");

    await new PrettierWorkspaceFormatter().format(workspace);

    assert.ok(!existsSync(sentinel), "prettier executed a workspace config");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// The formatter must run the control plane's own Prettier, never a binary the
// workspace provides. A patch can create node_modules/.bin/prettier.
test("a prettier binary planted in the workspace is never run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "formatter-safety-"));
  try {
    const sentinel = join(workspace, "PWNED");
    const bin = join(workspace, "node_modules", ".bin");
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(bin, { recursive: true });
    const planted = join(bin, "prettier");
    writeFileSync(planted, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`);
    chmodSync(planted, 0o755);
    writeFileSync(join(workspace, "code.ts"), "export const x   =    1;\n");

    await new PrettierWorkspaceFormatter().format(workspace);

    assert.ok(
      !existsSync(sentinel),
      "the workspace's own prettier binary was executed",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// And it must still actually format, or the safety above would be trivially
// satisfied by doing nothing.
test("the formatter still formats", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "formatter-safety-"));
  try {
    const file = join(workspace, "code.ts");
    writeFileSync(file, "export const x   =    1;\n");

    await new PrettierWorkspaceFormatter().format(workspace);

    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(file, "utf8"), "export const x = 1;\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
