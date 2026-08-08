import { createHash, randomUUID } from "node:crypto";
import type {
  DerivedIndex,
  KnowledgeAuthority,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeStatus,
  PurgePlan,
} from "./types.js";

const transitions: Record<KnowledgeStatus, ReadonlyArray<KnowledgeStatus>> = {
  candidate: ["verified", "deprecated"],
  verified: ["curated", "deprecated"],
  curated: ["reusable", "deprecated"],
  reusable: ["deprecated", "superseded"],
  deprecated: [],
  superseded: [],
};
export class KnowledgeCatalog {
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly indexes = new Map<string, DerivedIndex>();
  private readonly purgePending = new Set<string>();
  private readonly purgePlans = new Map<string, PurgePlan>();

  add(item: KnowledgeItem) {
    validateItem(item);
    if (this.items.has(item.id)) throw new Error("knowledge item exists");
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }
  transition(
    id: string,
    expectedVersion: number,
    status: KnowledgeStatus,
    evidenceSha256: string,
  ) {
    const current = this.require(id);
    if (current.version !== expectedVersion)
      throw new Error("stale knowledge fence");
    if (!transitions[current.status].includes(status))
      throw new Error("illegal knowledge transition");
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256))
      throw new Error("invalid knowledge evidence");
    if (
      ["verified", "curated", "reusable"].includes(status) &&
      current.verificationEvidence.length === 0
    )
      throw new Error("verification evidence required");
    if (
      status === "reusable" &&
      (current.classification === "private" || current.scope.kind === "private")
    )
      throw new Error("private knowledge cannot become reusable");
    const next = { ...current, status, version: current.version + 1 };
    this.items.set(id, next);
    return structuredClone(next);
  }
  supersede(id: string, replacement: KnowledgeItem, evidenceSha256: string) {
    const current = this.require(id);
    if (current.status !== "reusable")
      throw new Error("only reusable knowledge can be superseded");
    if (
      replacement.supersedesId !== id ||
      !sameScope(current.scope, replacement.scope)
    )
      throw new Error("invalid knowledge supersession");
    this.add(replacement);
    this.transition(id, current.version, "superseded", evidenceSha256);
    return structuredClone(replacement);
  }
  retrieve(query: string, authority: KnowledgeAuthority, limit = 20) {
    const terms = query
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter((term) => term.length >= 2)
      .slice(0, 10);
    if (
      terms.length === 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("invalid knowledge query");
    return [...this.items.values()]
      .filter(
        (item) =>
          item.status === "reusable" &&
          !this.purgePending.has(item.id) &&
          visible(item, authority),
      )
      .map((item) => ({
        item,
        score: terms.reduce(
          (sum, term) =>
            sum +
            occurrences(`${item.title} ${item.body}`.toLocaleLowerCase(), term),
          0,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.item.confidencePermille - a.item.confidencePermille ||
          a.item.id.localeCompare(b.item.id),
      )
      .slice(0, limit)
      .map(({ item }) => structuredClone(item));
  }
  addDerivedIndex(index: DerivedIndex) {
    if (
      !this.items.has(index.sourceItemId) ||
      index.state !== "active" ||
      this.indexes.has(index.id) ||
      !/^(index|object):\/\/[a-zA-Z0-9/_-]+$/.test(index.objectRef)
    )
      throw new Error("invalid derived index");
    if (index.kind === "embedding")
      throw new Error("embeddings are not enabled");
    this.indexes.set(index.id, structuredClone(index));
  }
  planSourceDeletion(sourceItemId: string, createdAt: string): PurgePlan {
    const replay = this.purgePlans.get(sourceItemId);
    if (replay) return structuredClone(replay);
    const source = this.require(sourceItemId),
      derived = [...this.indexes.values()]
        .filter(
          (index) =>
            index.sourceItemId === sourceItemId && index.state === "active",
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      payload = `${source.id}\0${source.sourceSha256}\0${derived.map((item) => item.id).join("\0")}`;
    for (const index of derived)
      this.indexes.set(index.id, { ...index, state: "purge_pending" });
    this.purgePending.add(sourceItemId);
    const plan = {
      id: randomUUID(),
      sourceItemId,
      sourceSha256: source.sourceSha256,
      derivedIndexIds: derived.map((item) => item.id),
      planSha256: createHash("sha256").update(payload).digest("hex"),
      createdAt,
    };
    this.purgePlans.set(sourceItemId, plan);
    return structuredClone(plan);
  }
  private require(id: string) {
    const item = this.items.get(id);
    if (!item) throw new Error("knowledge item missing");
    return item;
  }
}
function validateItem(item: KnowledgeItem) {
  if (
    !item.id ||
    item.version !== 1 ||
    item.title.length < 1 ||
    item.title.length > 200 ||
    item.body.length < 1 ||
    item.body.length > 100_000 ||
    !/^[a-f0-9]{64}$/.test(item.sourceSha256) ||
    item.confidencePermille < 0 ||
    item.confidencePermille > 1000 ||
    item.license.length < 1 ||
    item.scope.scopeId.length < 1
  )
    throw new Error("invalid knowledge item");
  if (item.status !== "candidate")
    throw new Error("knowledge must begin as candidate");
  if (item.scope.kind === "global" && item.classification !== "public")
    throw new Error("global knowledge must be public");
}
function visible(item: KnowledgeItem, authority: KnowledgeAuthority) {
  if (item.classification === "private" && item.scope.kind !== "private")
    return false;
  switch (item.scope.kind) {
    case "global":
      return authority.allowGlobal && item.classification === "public";
    case "organization":
      return (
        item.scope.scopeId === authority.organizationId &&
        item.classification !== "private"
      );
    case "project":
      return authority.projectIds.includes(item.scope.scopeId);
    case "contract":
      return authority.contractIds.includes(item.scope.scopeId);
    case "session":
      return authority.sessionIds.includes(item.scope.scopeId);
    case "private":
      return authority.privatePrincipalId === item.scope.scopeId;
  }
}
const sameScope = (a: KnowledgeScope, b: KnowledgeScope) =>
  a.kind === b.kind && a.scopeId === b.scopeId;
function occurrences(value: string, term: string) {
  let count = 0,
    offset = 0;
  while ((offset = value.indexOf(term, offset)) !== -1) {
    count++;
    offset += term.length;
  }
  return count;
}
