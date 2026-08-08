import { randomUUID } from "node:crypto";
import type {
  GeneratedProject,
  LifecycleRecord,
  ProjectState,
} from "./types.js";

const nextStates: Record<ProjectState, ReadonlyArray<ProjectState>> = {
  idea: ["blueprint"],
  blueprint: ["provisioned"],
  provisioned: ["development"],
  development: ["demo", "archived"],
  demo: ["development", "approved", "archived"],
  approved: ["production", "archived"],
  production: ["maintained", "archived"],
  maintained: ["production", "archived"],
  archived: ["exported", "deleted"],
  exported: ["deleted"],
  deleted: [],
};
const approvalStates = new Set<ProjectState>([
  "production",
  "archived",
  "exported",
  "deleted",
]);
export interface TransitionRequest {
  idempotencyKey: string;
  expectedVersion: number;
  to: ProjectState;
  actorId: string;
  correlationId: string;
  evidenceSha256: string;
  approvalRef?: string;
  occurredAt: string;
}

export class ProjectLifecycle {
  private readonly records = new Map<string, LifecycleRecord>();
  transition(project: GeneratedProject, request: TransitionRequest) {
    const replay = this.records.get(`${project.id}\0${request.idempotencyKey}`);
    if (replay) return { project, record: replay, replay: true } as const;
    if (project.version !== request.expectedVersion)
      throw new Error("stale project fence");
    if (!nextStates[project.state].includes(request.to))
      throw new Error("illegal project lifecycle transition");
    if (approvalStates.has(request.to) && !request.approvalRef)
      throw new Error("scoped approval required");
    if (!/^[a-f0-9]{64}$/.test(request.evidenceSha256))
      throw new Error("invalid lifecycle evidence");
    const next = {
      ...project,
      state: request.to,
      version: project.version + 1,
      updatedAt: request.occurredAt,
    };
    const record: LifecycleRecord = {
      id: randomUUID(),
      projectId: project.id,
      idempotencyKey: request.idempotencyKey,
      from: project.state,
      to: request.to,
      actorId: request.actorId,
      correlationId: request.correlationId,
      evidenceSha256: request.evidenceSha256,
      ...(request.approvalRef ? { approvalRef: request.approvalRef } : {}),
      resultingVersion: next.version,
      occurredAt: request.occurredAt,
    };
    this.records.set(`${project.id}\0${request.idempotencyKey}`, record);
    return { project: next, record, replay: false } as const;
  }
}
