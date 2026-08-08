export type KnowledgeStatus =
  | "candidate"
  | "verified"
  | "curated"
  | "reusable"
  | "deprecated"
  | "superseded";
export type KnowledgeClassification =
  "public" | "internal" | "confidential" | "private";
export type KnowledgeScopeKind =
  "global" | "organization" | "project" | "contract" | "session" | "private";
export interface KnowledgeScope {
  kind: KnowledgeScopeKind;
  scopeId: string;
}
export interface KnowledgeItem {
  id: string;
  version: number;
  title: string;
  body: string;
  status: KnowledgeStatus;
  classification: KnowledgeClassification;
  scope: KnowledgeScope;
  sourceType:
    | "decision"
    | "pattern"
    | "blueprint"
    | "component"
    | "test"
    | "solution"
    | "migration";
  sourceRef: string;
  sourceSha256: string;
  license: string;
  confidencePermille: number;
  dependencies: ReadonlyArray<string>;
  verificationEvidence: ReadonlyArray<string>;
  supersedesId?: string;
  createdAt: string;
}
export interface KnowledgeAuthority {
  organizationId: string;
  projectIds: ReadonlyArray<string>;
  contractIds: ReadonlyArray<string>;
  sessionIds: ReadonlyArray<string>;
  privatePrincipalId?: string;
  allowGlobal: boolean;
}
export interface DerivedIndex {
  id: string;
  sourceItemId: string;
  kind: "full_text" | "metadata" | "embedding";
  objectRef: string;
  state: "active" | "purge_pending" | "purged";
}
export interface PurgePlan {
  id: string;
  sourceItemId: string;
  sourceSha256: string;
  derivedIndexIds: ReadonlyArray<string>;
  planSha256: string;
  createdAt: string;
}
