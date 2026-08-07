import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirtyPaths, isOwnedPath, missingContractSections, ownershipManifest } from "../scripts/verify-contract.js";

test("CONTRACT-001 declares all mandatory control sections", () => {
  const contract = readFileSync("docs/contracts/CONTRACT-001/contract.md", "utf8");
  const required = ["Objective", "Scope", "Out of scope", "Milestones", "Acceptance", "Rollback", "File ownership"];
  for (const section of required) assert.match(contract, new RegExp(`## ${section}`));
});

test("product boundary identifies generated projects as dynamic", () => {
  const vision = readFileSync("docs/product/vision.md", "utf8");
  assert.match(vision, /dynamic registry entries/);
  assert.match(vision, /not control-plane modules/);
});

test("contract verifier rejects missing control sections", () => {
  assert.deepEqual(missingContractSections("## Objective\n"), [
    "## Scope",
    "## Out of scope",
    "## Milestones",
    "## Acceptance",
    "## Rollback",
    "## File ownership",
  ]);
});

test("contract verifier identifies dirty out-of-scope files", () => {
  const contract = readFileSync("docs/contracts/CONTRACT-001/contract.md", "utf8");
  const manifest = ownershipManifest(contract);
  const paths = dirtyPaths(" M src/config.ts\n?? docs/new.md\n?? unexpected.txt\n");
  assert.deepEqual(paths.filter((path) => !isOwnedPath(path, manifest)), ["unexpected.txt"]);
});
