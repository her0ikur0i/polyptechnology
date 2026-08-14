import { createHash } from "node:crypto";
import type { PostgresProjectFactory } from "./postgres-repository.js";
import type { ProjectState } from "./types.js";

// Advances a generated project's lifecycle at the two moments the generation
// pipeline actually completes something.
//
// `ProjectLifecycle` has always defined
// `idea -> blueprint -> provisioned -> development -> demo -> ...`, and until
// 2026-08-11 **nothing in the codebase ever wrote the last two.** Two call
// sites transitioned a project and both went to `blueprint`. So a project
// could be scaffolded on disk and have real generated code committed to it,
// and its recorded state would still say a blueprint had been attached and
// nothing more.
//
// The consequence was not cosmetic: the pipeline had no representation of
// "the factory finished building this", which is the state every downstream
// question depends on -- what to show the owner, what can be demoed, what can
// be detached (goal 5). CONTRACT-017C could not meet its own acceptance gate
// without this.

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export interface ProjectLifecycleAdvancer {
  provisioned(projectId: string, workspaceRef: string): Promise<void>;
  developed(projectId: string, taskId: string): Promise<void>;
  exported(projectId: string): Promise<void>;
}

export class FactoryLifecycleAdvancer implements ProjectLifecycleAdvancer {
  constructor(private readonly factory: PostgresProjectFactory) {}

  // Called once a workspace exists on disk as a real git repository.
  async provisioned(projectId: string, workspaceRef: string): Promise<void> {
    await this.advance(projectId, "provisioned", `provisioned:${workspaceRef}`);
  }

  // Called once a patch has been accepted -- meaning a provider produced it, it
  // stayed inside its ownership manifest, it applied, and it passed typecheck,
  // format:check and test inside the isolated sandbox.
  async developed(projectId: string, taskId: string): Promise<void> {
    await this.advance(projectId, "development", `generated:${taskId}`);
  }

  // Called once the owner has pushed the project out of the factory (goal 5,
  // detach): the factory stops treating it as in-progress work.
  async exported(projectId: string): Promise<void> {
    await this.advance(projectId, "exported", `exported:${projectId}`);
  }

  // Idempotent by design, in two directions.
  //
  // Already at the target state: nothing to do. A retried task, a replayed
  // delivery or a second accepted patch must not throw "illegal project
  // lifecycle transition" at a project that is already where it belongs.
  //
  // Already past the target state: also nothing to do. A project promoted to
  // `demo` must not be dragged back to `development` because a late patch
  // landed; the lifecycle only ever moves forward.
  private async advance(
    projectId: string,
    to: ProjectState,
    evidence: string,
  ): Promise<void> {
    const project = await this.factory.getProject(projectId);
    if (project === undefined)
      throw new Error(`project ${projectId} not found for lifecycle advance`);
    if (project.state === to) return;
    if (ORDER.indexOf(project.state) > ORDER.indexOf(to)) return;

    await this.factory.transition(projectId, {
      // Deterministic, so a replay of the same event replays the same
      // transition rather than creating a second lifecycle record.
      idempotencyKey: deterministicKeyFor(projectId, to),
      expectedVersion: project.version,
      to,
      actorId: "factory-generation",
      correlationId: evidence,
      evidenceSha256: sha256(evidence),
      occurredAt: new Date().toISOString(),
    });
  }
}

// The forward-only spine of the lifecycle. States off this spine (`archived`,
// `exported`, `deleted`) are never targets here and sort last, so a project in
// any of them is left alone.
const ORDER: ReadonlyArray<ProjectState> = [
  "idea",
  "blueprint",
  "provisioned",
  "development",
  "demo",
  "approved",
  "production",
  "maintained",
  "archived",
  "exported",
  "deleted",
];

function deterministicKeyFor(projectId: string, to: ProjectState): string {
  // The factory's transition() takes an idempotency key as an opaque string;
  // a stable one per (project, target state) makes replays free.
  return sha256(`lifecycle:${projectId}:${to}`).slice(0, 36);
}
