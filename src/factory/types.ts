export type BlueprintStatus = "draft" | "published" | "superseded" | "retired";
export type ProjectState =
  | "idea"
  | "blueprint"
  | "provisioned"
  | "development"
  | "demo"
  | "approved"
  | "production"
  | "maintained"
  | "archived"
  | "exported"
  | "deleted";

export interface ResourceEnvelope {
  cpuMillis: number;
  memoryMiB: number;
  diskMiB: number;
  maxProcesses: number;
  network: "none" | "egress-allowlist";
}
export interface BlueprintDocument {
  schemaVersion: 1;
  slug: string;
  displayName: string;
  stack: { runtime: string; framework: string; database: string };
  requirements: ReadonlyArray<string>;
  qualityGates: ReadonlyArray<string>;
  capabilities: ReadonlyArray<string>;
  resources: ResourceEnvelope;
  lifecyclePolicy: { productionApproval: true; destructiveApproval: true };
}
export interface BlueprintVersion {
  id: string;
  blueprintId: string;
  version: number;
  status: BlueprintStatus;
  document: BlueprintDocument;
  documentSha256: string;
  createdAt: string;
  publishedAt?: string;
}
export interface GeneratedProject {
  id: string;
  slug: string;
  displayName: string;
  blueprintVersionId: string;
  state: ProjectState;
  version: number;
  repositoryRef: string;
  workspaceRef: string;
  databaseNamespace: string;
  secretNamespace: string;
  budgetScope: string;
  createdAt: string;
  updatedAt: string;
}
export interface LifecycleRecord {
  id: string;
  projectId: string;
  idempotencyKey: string;
  from: ProjectState;
  to: ProjectState;
  actorId: string;
  correlationId: string;
  evidenceSha256: string;
  approvalRef?: string;
  resultingVersion: number;
  occurredAt: string;
}
export interface CapacityRequest {
  id: string;
  projectId: string;
  providerId: string;
  priority: number;
  interactive: boolean;
  queuedAtMs: number;
  budgetAvailable: boolean;
  resources: ResourceEnvelope;
}
export interface CapacityLimits {
  globalConcurrency: number;
  providerConcurrency: number;
  projectConcurrency: number;
  cpuMillis: number;
  memoryMiB: number;
  diskMiB: number;
  maxProcesses: number;
  minimumFreeDiskMiB: number;
}
export interface CapacityObservation {
  freeDiskMiB: number;
  active: ReadonlyArray<CapacityRequest>;
}
export interface CapacityLease {
  request: CapacityRequest;
  fence: number;
  expiresAtMs: number;
}
