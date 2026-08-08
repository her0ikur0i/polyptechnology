import { createHash, timingSafeEqual } from "node:crypto";
import type { ConversationStore, Proposal } from "../orchestrator/types.js";
import type { PostgresProjectFactory } from "../factory/postgres-repository.js";

export interface OwnerContext {
  authenticated: boolean;
  actorId: string;
  csrfToken: string;
}
export class OwnerCommandService {
  constructor(
    private readonly factory: PostgresProjectFactory,
    private readonly conversations: ConversationStore,
    private readonly expectedCsrfToken: string,
  ) {
    if (expectedCsrfToken.length < 32)
      throw new Error("CSRF secret is too short");
  }
  async createProject(context: OwnerContext, command: ProjectCommand) {
    this.authorize(context);
    if (
      !/^[a-f0-9-]{36}$/.test(command.idempotencyKey) ||
      !Number.isFinite(Date.parse(command.occurredAt))
    )
      throw new Error("invalid project command envelope");
    const projectId = deterministicUuid(
        `${context.actorId}:${command.idempotencyKey}:project`,
      ),
      blueprintId = deterministicUuid(
        `${context.actorId}:${command.idempotencyKey}:blueprint`,
      ),
      versionId = deterministicUuid(
        `${context.actorId}:${command.idempotencyKey}:version`,
      );
    await this.factory.publishBlueprint({
      blueprintId,
      versionId,
      version: 1,
      createdAt: command.occurredAt,
      document: {
        schemaVersion: 1,
        slug: command.slug,
        displayName: command.displayName,
        stack: {
          runtime: command.runtime,
          framework: command.framework,
          database: command.database,
        },
        requirements: command.requirements,
        qualityGates: [
          "locked-install",
          "typecheck",
          "test",
          "build",
          "security",
        ],
        capabilities: ["workspace:write"],
        resources: {
          cpuMillis: 500,
          memoryMiB: 1024,
          diskMiB: 4096,
          maxProcesses: 32,
          network: "none",
        },
        lifecyclePolicy: {
          productionApproval: true,
          destructiveApproval: true,
        },
      },
    });
    let project = await this.factory.createProject({
      id: projectId,
      slug: command.slug,
      displayName: command.displayName,
      blueprintVersionId: versionId,
      createdAt: command.occurredAt,
    });
    project = (
      await this.factory.transition(project.id, {
        idempotencyKey: command.idempotencyKey,
        expectedVersion: 0,
        to: "blueprint",
        actorId: context.actorId,
        correlationId: command.idempotencyKey,
        evidenceSha256: digest(command),
        occurredAt: command.occurredAt,
      })
    ).project;
    return {
      projectId: project.id,
      state: project.state,
      repositoryRef: project.repositoryRef,
    };
  }
  async createProposal(context: OwnerContext, command: ProposalCommand) {
    this.authorize(context);
    if (
      !/^[a-f0-9-]{36}$/.test(command.projectId) ||
      !/^[a-f0-9-]{36}$/.test(command.idempotencyKey) ||
      command.title.trim().length < 1 ||
      command.objective.trim().length < 10 ||
      !Number.isFinite(Date.parse(command.occurredAt))
    )
      throw new Error("invalid proposal command");
    if (!(await this.factory.getProject(command.projectId)))
      throw new Error("project missing");
    const conversationId = deterministicUuid(
        `${context.actorId}:${command.idempotencyKey}:conversation`,
      ),
      proposalId = deterministicUuid(
        `${context.actorId}:${command.idempotencyKey}:proposal`,
      );
    await this.conversations.createConversation(
      {
        id: conversationId,
        projectId: command.projectId,
        title: command.title.trim(),
        version: 0,
        createdAt: new Date(command.occurredAt),
      },
      command.idempotencyKey,
    );
    const candidate = `# Contract proposal\n\n## Objective\n\n${command.objective.trim()}\n`,
      proposal: Proposal = {
        id: proposalId,
        conversationId,
        projectId: command.projectId,
        version: 1,
        state: "draft",
        contractCandidate: candidate,
        candidateSha256: digest(candidate),
      };
    const created = await this.conversations.createProposal(
        proposal,
        command.idempotencyKey,
      ),
      reviewed =
        created.state === "owner_review"
          ? created
          : await this.conversations.transitionProposal(
              command.projectId,
              proposalId,
              1,
              "owner_review",
            );
    return { conversationId, proposalId: reviewed.id, state: reviewed.state };
  }
  private authorize(context: OwnerContext) {
    const expected = Buffer.from(this.expectedCsrfToken),
      actual = Buffer.from(context.csrfToken);
    if (
      !context.authenticated ||
      context.actorId.length < 3 ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      throw new Error("owner authorization required");
  }
}
export interface ProjectCommand {
  idempotencyKey: string;
  occurredAt: string;
  slug: string;
  displayName: string;
  runtime: string;
  framework: string;
  database: string;
  requirements: ReadonlyArray<string>;
}
export interface ProposalCommand {
  idempotencyKey: string;
  occurredAt: string;
  projectId: string;
  title: string;
  objective: string;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
function deterministicUuid(value: string) {
  const hex = digest(value).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
