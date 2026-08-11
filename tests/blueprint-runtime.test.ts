import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRuntime,
  SUPPORTED_RUNTIMES,
} from "../src/factory/blueprint.js";

// The first blueprint this factory ever produced said `"runtime": "node-22"`,
// and could not be provisioned: NodeWorkspaceProvisioner compares against the
// single string "node". The model was not wrong -- the host really does run
// Node 22 -- the translation boundary simply never converted a free-text
// answer into the controlled vocabulary everything downstream assumes.

test("the runtime a real model actually produced normalizes", () => {
  assert.equal(normalizeRuntime("node-22"), "node");
});

test("plausible ways of naming the supported runtime all normalize", () => {
  for (const written of [
    "node",
    "Node",
    "NODE",
    " node ",
    "node.js",
    "nodejs",
    "Node.js 22",
    "node22",
    "node_20",
    "typescript",
    "TypeScript",
    "ts",
    "javascript",
    "js",
  ])
    assert.equal(
      normalizeRuntime(written),
      "node",
      `expected node for ${written}`,
    );
});

// The strictness is the point. A blueprint asking for a runtime this factory
// cannot scaffold must fail closed -- scaffolding it as Node would produce a
// project that looks generated and is wrong, which is worse than a refusal.
test("an unsupported runtime maps to nothing rather than being guessed", () => {
  for (const written of [
    "python",
    "python3",
    "go",
    "golang",
    "rust",
    "ruby",
    "php",
    "java",
    "dotnet",
    "",
    "   ",
    "banana",
  ])
    assert.equal(
      normalizeRuntime(written),
      undefined,
      `expected no runtime for ${written}`,
    );
});

test("every supported runtime normalizes to itself", () => {
  for (const runtime of SUPPORTED_RUNTIMES)
    assert.equal(normalizeRuntime(runtime), runtime);
});
