import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { KnowledgeCatalog } from "../src/knowledge/service.js";
import type {
  KnowledgeAuthority,
  KnowledgeItem,
} from "../src/knowledge/types.js";

const authority: KnowledgeAuthority = {
  organizationId: "org-1",
  projectIds: ["project-1"],
  contractIds: [],
  sessionIds: [],
  allowGlobal: true,
};
const candidate = (
  scopeId = "project-1",
  classification: KnowledgeItem["classification"] = "internal",
): KnowledgeItem => ({
  id: randomUUID(),
  version: 1,
  title: "Verified retry pattern",
  body: "Bounded exponential retry with idempotency evidence",
  status: "candidate",
  classification,
  scope: {
    kind: classification === "private" ? "private" : "project",
    scopeId,
  },
  sourceType: "pattern",
  sourceRef: "artifact://evidence/retry",
  sourceSha256: "b".repeat(64),
  license: "Apache-2.0",
  confidencePermille: 900,
  dependencies: ["idempotency"],
  verificationEvidence: ["c".repeat(64)],
  createdAt: "2026-08-08T00:00:00.000Z",
});
function reusable(catalog: KnowledgeCatalog, item: KnowledgeItem) {
  catalog.add(item);
  let current = catalog.transition(item.id, 1, "verified", "d".repeat(64));
  current = catalog.transition(
    item.id,
    current.version,
    "curated",
    "d".repeat(64),
  );
  return catalog.transition(
    item.id,
    current.version,
    "reusable",
    "d".repeat(64),
  );
}

test("knowledge promotion and retrieval fail closed across project and private scope", () => {
  const catalog = new KnowledgeCatalog(),
    visible = reusable(catalog, candidate()),
    foreign = reusable(catalog, candidate("project-2"));
  assert.deepEqual(
    catalog.retrieve("retry pattern", authority).map((item) => item.id),
    [visible.id],
  );
  assert.notEqual(foreign.id, visible.id);
  const privateItem = candidate("principal-1", "private");
  catalog.add(privateItem);
  let privateVerified = catalog.transition(
    privateItem.id,
    1,
    "verified",
    "d".repeat(64),
  );
  privateVerified = catalog.transition(
    privateItem.id,
    privateVerified.version,
    "curated",
    "d".repeat(64),
  );
  assert.throws(
    () =>
      catalog.transition(
        privateItem.id,
        privateVerified.version,
        "reusable",
        "d".repeat(64),
      ),
    /private/,
  );
});

test("supersession preserves scope and source deletion covers every derived index", () => {
  const catalog = new KnowledgeCatalog(),
    original = reusable(catalog, candidate()),
    replacement = { ...candidate(), supersedesId: original.id };
  catalog.supersede(original.id, replacement, "e".repeat(64));
  catalog.addDerivedIndex({
    id: randomUUID(),
    sourceItemId: replacement.id,
    kind: "metadata",
    objectRef: "index://knowledge/metadata",
    state: "active",
  });
  catalog.addDerivedIndex({
    id: randomUUID(),
    sourceItemId: replacement.id,
    kind: "full_text",
    objectRef: "index://knowledge/full_text",
    state: "active",
  });
  const plan = catalog.planSourceDeletion(
    replacement.id,
    "2026-08-08T00:02:00.000Z",
  );
  assert.equal(plan.derivedIndexIds.length, 2);
  assert.equal(catalog.retrieve("retry pattern", authority).length, 0);
  assert.equal(
    catalog.planSourceDeletion(replacement.id, "2026-08-08T00:03:00.000Z").id,
    plan.id,
  );
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
  assert.throws(
    () =>
      catalog.addDerivedIndex({
        id: randomUUID(),
        sourceItemId: replacement.id,
        kind: "embedding",
        objectRef: "index://knowledge/vector",
        state: "active",
      }),
    /not enabled/,
  );
});
