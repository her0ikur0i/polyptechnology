import { createHash, timingSafeEqual } from "node:crypto";
import type { ConversationStore, Proposal } from "../orchestrator/types.js";
import type { PostgresProjectFactory } from "../factory/postgres-repository.js";
import type { OrchestratorService } from "../orchestrator/service.js";
import { deterministicUuid } from "../deterministic-id.js";

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
    private readonly orchestrator: OrchestratorService,
    // How a queued assistant reply gets created. Injected rather than imported
    // so the service owns the *sequence* -- append, then queue -- while the
    // caller supplies the mechanism.
    //
    // This exists because the sequence used to live in the Express route
    // instead. A second caller (Telegram) went through this service precisely
    // to avoid building a weaker second door, stored the message correctly, and
    // never queued a reply -- because half the behaviour was in the transport
    // layer where only one caller could reach it. Optional so existing
    // constructions keep compiling; a caller that omits it gets no reply
    // queued, which is now a visible choice rather than an accident.
    private readonly queueReply?: (input: {
      conversationId: string;
      projectId: string;
      expectedVersion: number;
    }) => Promise<{ taskId: string }>,
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
  // Starts a conversation for an existing project, or -- when no projectId
  // is given -- bootstraps a fresh project in "idea" lifecycle state first
  // (docs/SYSTEM-SPECIFICATION.md Section 17 anticipates this state, but
  // generated_projects.blueprint_id/blueprint_version_id are NOT NULL, so a
  // real project row still needs a real, already-published blueprint
  // version to exist -- reusing publishBlueprint()/createProject() exactly
  // as createProject() below does, with an explicit placeholder document,
  // is far less invasive than loosening that constraint). Deliberately
  // does NOT transition to the "blueprint" state afterward, unlike
  // createProject() -- the placeholder isn't a real blueprint yet, so the
  // project honestly stays at "idea" until CONTRACT-014 M6 publishes a real
  // one derived from the conversation and re-points blueprint_version_id.
  async startConversation(
    context: OwnerContext,
    command: StartConversationCommand,
  ) {
    this.authorize(context);
    if (
      !/^[a-f0-9-]{36}$/.test(command.idempotencyKey) ||
      !Number.isFinite(Date.parse(command.occurredAt)) ||
      command.title.trim().length < 1 ||
      command.title.trim().length > 200
    )
      throw new Error("invalid conversation command");
    let projectId = command.projectId;
    if (projectId !== undefined) {
      if (!/^[a-f0-9-]{36}$/.test(projectId))
        throw new Error("invalid project id");
      if (!(await this.factory.getProject(projectId)))
        throw new Error("project missing");
    } else {
      projectId = deterministicUuid(
        `${context.actorId}:${command.idempotencyKey}:project`,
      );
      const blueprintId = deterministicUuid(
          `${context.actorId}:${command.idempotencyKey}:blueprint`,
        ),
        versionId = deterministicUuid(
          `${context.actorId}:${command.idempotencyKey}:version`,
        ),
        slug = `untitled-${projectId.replaceAll("-", "").slice(0, 12)}`;
      await this.factory.publishBlueprint({
        blueprintId,
        versionId,
        version: 1,
        createdAt: command.occurredAt,
        document: {
          schemaVersion: 1,
          slug,
          displayName: "Untitled project",
          stack: {
            runtime: "unspecified",
            framework: "unspecified",
            database: "unspecified",
          },
          requirements: ["Pending clarification via conversation"],
          qualityGates: ["typecheck", "test"],
          capabilities: [],
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
      await this.factory.createProject({
        id: projectId,
        slug,
        displayName: "Untitled project",
        blueprintVersionId: versionId,
        createdAt: command.occurredAt,
      });
    }
    const conversationId = deterministicUuid(
      `${context.actorId}:${command.idempotencyKey}:conversation`,
    );
    const conversation = await this.conversations.createConversation(
      {
        id: conversationId,
        projectId,
        title: command.title.trim(),
        version: 0,
        createdAt: new Date(command.occurredAt),
      },
      command.idempotencyKey,
    );
    return {
      conversationId: conversation.id,
      projectId,
      title: conversation.title,
      version: conversation.version,
    };
  }
  async renameConversation(
    context: OwnerContext,
    command: RenameConversationCommand,
  ) {
    this.authorize(context);
    const title = command.title.trim();
    if (
      !/^[a-f0-9-]{36}$/.test(command.projectId) ||
      !/^[a-f0-9-]{36}$/.test(command.conversationId) ||
      title.length < 1 ||
      title.length > 200 ||
      !Number.isSafeInteger(command.expectedVersion)
    )
      throw new Error("invalid rename command");
    return this.conversations.renameConversation(
      command.projectId,
      command.conversationId,
      title,
      command.expectedVersion,
    );
  }
  async setConversationArchived(
    context: OwnerContext,
    command: ArchiveConversationCommand,
  ) {
    this.authorize(context);
    if (
      !/^[a-f0-9-]{36}$/.test(command.projectId) ||
      !/^[a-f0-9-]{36}$/.test(command.conversationId) ||
      !Number.isSafeInteger(command.expectedVersion)
    )
      throw new Error("invalid archive command");
    return this.conversations.setConversationArchived(
      command.projectId,
      command.conversationId,
      command.archived,
      command.expectedVersion,
    );
  }
  async sendMessage(context: OwnerContext, command: SendMessageCommand) {
    this.authorize(context);
    const content = command.content.trim();
    if (
      !/^[a-f0-9-]{36}$/.test(command.projectId) ||
      !/^[a-f0-9-]{36}$/.test(command.conversationId) ||
      !/^[a-f0-9-]{36}$/.test(command.idempotencyKey) ||
      !Number.isFinite(Date.parse(command.occurredAt)) ||
      content.length < 1 ||
      content.length > 20_000 ||
      !Number.isSafeInteger(command.expectedVersion) ||
      command.expectedVersion < 0
    )
      throw new Error("invalid message command");
    const messageId = deterministicUuid(
      `${context.actorId}:${command.idempotencyKey}:message`,
    );
    const appended = await this.conversations.appendMessage(
      {
        id: messageId,
        conversationId: command.conversationId,
        projectId: command.projectId,
        role: "owner",
        content,
        // "internal" is the safe default for an owner-authored planning
        // message -- never "public" (this is a private conversation), never
        // "confidential"/"secret" without an explicit signal this content
        // warrants it (ADR-0002's classification is what later gates
        // context eligibility, not this route's guess).
        classification: "internal",
        contentSha256: digest(content),
        createdAt: new Date(command.occurredAt),
      },
      command.expectedVersion,
      command.idempotencyKey,
    );

    // Queued after the append, and only if the append succeeded: a reply to a
    // message that was never stored would answer a question nobody asked.
    // expectedVersion advances by one because the owner's message is now in
    // the thread.
    const reply = await this.queueReply?.({
      conversationId: command.conversationId,
      projectId: command.projectId,
      expectedVersion: command.expectedVersion + 1,
    });

    return reply === undefined
      ? appended
      : { ...appended, replyTaskId: reply.taskId };
  }
  // Compiles the conversation's actual message history into a narrative
  // brief and drafts a real proposal from it, then immediately requests
  // owner review -- the "narrative brief" this milestone's scope calls
  // for is the transcript itself, not a separate AI-generated summary
  // (that would be an extra AiGateway call for a document CONTRACT-014 M6
  // reads right back apart anyway; keeping M5 to a mechanical,
  // deterministic compilation keeps this milestone about wiring the
  // existing draft -> owner_review -> approved -> handed_off state
  // machine into the UI, not about narrative quality).
  async draftProposal(context: OwnerContext, command: DraftProposalCommand) {
    this.authorize(context);
    if (
      !/^[a-f0-9-]{36}$/.test(command.projectId) ||
      !/^[a-f0-9-]{36}$/.test(command.conversationId) ||
      !/^[a-f0-9-]{36}$/.test(command.idempotencyKey) ||
      !Number.isFinite(Date.parse(command.occurredAt))
    )
      throw new Error("invalid draft-proposal command");
    const messages = await this.conversations.messages(
      command.projectId,
      command.conversationId,
    );
    if (messages.length === 0)
      throw new Error("conversation has no messages to draft a proposal from");
    const transcript = messages
      .filter((message) => message.classification !== "secret")
      .map((message) => `**${message.role}**: ${message.content}`)
      .join("\n\n");
    const draft = await this.orchestrator.submitProposal({
      projectId: command.projectId,
      conversationId: command.conversationId,
      contractCandidate: transcript,
      idempotencyKey: command.idempotencyKey,
    });
    const reviewed =
      draft.state === "owner_review"
        ? draft
        : await this.orchestrator.requestOwnerReview(
            command.projectId,
            draft.id,
            draft.version,
          );
    return {
      proposalId: reviewed.id,
      conversationId: command.conversationId,
      state: reviewed.state,
      version: reviewed.version,
      contractCandidate: reviewed.contractCandidate,
    };
  }
  // Approve and hand off in one action -- there is no owner decision
  // between "approved" and "handed_off" (handoff only freezes/returns the
  // candidate for M6's translation step), so a single approve click does
  // both rather than making the owner press two buttons for one decision.
  async approveProposal(
    context: OwnerContext,
    command: ProposalDecisionCommand,
  ) {
    this.authorize(context);
    if (
      !/^[a-f0-9-]{36}$/.test(command.projectId) ||
      !/^[a-f0-9-]{36}$/.test(command.proposalId) ||
      !Number.isSafeInteger(command.expectedVersion)
    )
      throw new Error("invalid proposal decision command");
    const approved = await this.orchestrator.approve(
      command.projectId,
      command.proposalId,
      command.expectedVersion,
      deterministicUuid(`${context.actorId}:${command.proposalId}:approval`),
    );
    return this.orchestrator.handoff(
      command.projectId,
      command.proposalId,
      approved.version,
    );
  }
  async rejectProposal(
    context: OwnerContext,
    command: ProposalDecisionCommand,
  ) {
    this.authorize(context);
    if (
      !/^[a-f0-9-]{36}$/.test(command.projectId) ||
      !/^[a-f0-9-]{36}$/.test(command.proposalId) ||
      !Number.isSafeInteger(command.expectedVersion)
    )
      throw new Error("invalid proposal decision command");
    return this.orchestrator.reject(
      command.projectId,
      command.proposalId,
      command.expectedVersion,
    );
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
export interface StartConversationCommand {
  idempotencyKey: string;
  occurredAt: string;
  title: string;
  projectId?: string;
}
export interface SendMessageCommand {
  idempotencyKey: string;
  occurredAt: string;
  projectId: string;
  conversationId: string;
  expectedVersion: number;
  content: string;
}
export interface RenameConversationCommand {
  projectId: string;
  conversationId: string;
  title: string;
  expectedVersion: number;
}
export interface ArchiveConversationCommand {
  projectId: string;
  conversationId: string;
  archived: boolean;
  expectedVersion: number;
}
export interface DraftProposalCommand {
  idempotencyKey: string;
  occurredAt: string;
  projectId: string;
  conversationId: string;
}
export interface ProposalDecisionCommand {
  projectId: string;
  proposalId: string;
  expectedVersion: number;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
