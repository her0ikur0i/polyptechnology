import { describe, expect, it } from "vitest";
import {
  parseActivePolicy,
  parseCodexOverrideResult,
  parseConversationAttachment,
  parseConversationAttachmentList,
  parseConversationMessageList,
  parseConversationProposal,
  parseConversationStartResult,
  parseConversationSummary,
  parseConversationSummaryList,
  parseDashboardSnapshot,
  parseFactoryProjectResult,
  parseGenerationTaskResult,
  parsePolicyStateResult,
  parseProposalApprovalResult,
  parseProposalCreationResult,
  parseProposalDraftResult,
  parseReplyTaskStatus,
  parseSendMessageResult,
  parseTelegramSettings,
  parseTelegramTestResult,
  parseTranslationTaskResult,
} from "../../src/dashboard/validation.js";
const observed = (data: unknown) => ({
  data,
  observedAt: "2026-08-08T00:00:00Z",
  freshness: "fresh",
  source: "test",
  issues: [],
});
const telegram = {
  authorizedChatIds: [],
  authorizedUserIds: [],
  configurationReady: false,
  liveProbeState: "not_run",
  approvalRequiredForProbe: true,
  webhookRegistered: false,
};
const base = {
  attention: observed([]),
  projects: observed([]),
  contracts: observed([]),
  attempts: observed([]),
  approvals: observed([]),
  telegram: observed(telegram),
  sequence: observed({ state: "running", ownerBlockers: 0 }),
  commandPolicy: { csrfToken: "csrf", canConfigureTelegram: false },
};
describe("dashboard payload validation", () => {
  it("accepts a structurally valid snapshot", () =>
    expect(parseDashboardSnapshot(base).sequence.data.state).toBe("running"));
  it("rejects aliases without concrete attempt identity and secret-shaped Telegram values", () => {
    expect(() =>
      parseDashboardSnapshot({
        ...base,
        attempts: observed([{ provider: "deepseek", model: "alias" }]),
      }),
    ).toThrow();
    expect(() =>
      parseDashboardSnapshot({
        ...base,
        telegram: observed({ ...telegram, secretRef: "raw-token" }),
      }),
    ).toThrow();
  });
});

describe("telegram settings response validation", () => {
  it("accepts a realistic saved-settings payload with and without a secret reference", () => {
    expect(parseTelegramSettings(telegram).webhookRegistered).toBe(false);
    expect(
      parseTelegramSettings({
        ...telegram,
        secretRef: "secret://polyp/telegram/bot",
      }).secretRef,
    ).toBe("secret://polyp/telegram/bot");
  });
  it("rejects a missing field, a mistyped boolean, an unknown probe state, and a non-array identity list", () => {
    expect(() =>
      parseTelegramSettings({ ...telegram, authorizedChatIds: undefined }),
    ).toThrow();
    expect(() =>
      parseTelegramSettings({ ...telegram, configurationReady: "yes" }),
    ).toThrow();
    expect(() =>
      parseTelegramSettings({ ...telegram, liveProbeState: "bogus" }),
    ).toThrow();
    expect(() =>
      parseTelegramSettings({ ...telegram, authorizedUserIds: "7" }),
    ).toThrow();
  });
  it("accepts and rejects Telegram test result payloads", () => {
    expect(
      parseTelegramTestResult({
        state: "passed",
        checkedAt: "2026-08-13T00:00:00.000Z",
        summary: "Telegram bot connectivity passed.",
      }).state,
    ).toBe("passed");
    expect(() =>
      parseTelegramTestResult({
        state: "queued",
        checkedAt: "2026-08-13T00:00:00.000Z",
        summary: "nope",
      }),
    ).toThrow();
  });
});

describe("factory and generation command responses", () => {
  it("accepts realistic createFactoryProject and generateProject payloads", () => {
    expect(
      parseFactoryProjectResult({
        projectId: "proj-1",
        state: "blueprint",
        repositoryRef: "refs/heads/main",
      }).state,
    ).toBe("blueprint");
    expect(
      parseGenerationTaskResult({
        taskId: "task-1",
        contractId: "contract-1",
        milestoneId: "milestone-1",
      }).taskId,
    ).toBe("task-1");
  });
  it("rejects a missing field and a mistyped field on each", () => {
    expect(() =>
      parseFactoryProjectResult({ projectId: "proj-1", state: "blueprint" }),
    ).toThrow();
    expect(() =>
      parseFactoryProjectResult({
        projectId: "proj-1",
        state: "blueprint",
        repositoryRef: 12,
      }),
    ).toThrow();
    expect(() =>
      parseGenerationTaskResult({
        taskId: "task-1",
        contractId: "contract-1",
      }),
    ).toThrow();
    expect(() =>
      parseGenerationTaskResult({
        taskId: "task-1",
        contractId: "contract-1",
        milestoneId: null,
      }),
    ).toThrow();
  });
});

describe("proposal creation, draft, approval, and translation responses", () => {
  it("accepts realistic responses from each step of the proposal lifecycle", () => {
    expect(
      parseProposalCreationResult({
        conversationId: "conv-1",
        proposalId: "proposal-1",
        state: "draft",
      }).state,
    ).toBe("draft");
    expect(
      parseProposalDraftResult({
        proposalId: "proposal-1",
        conversationId: "conv-1",
        state: "owner_review",
        version: 1,
        contractCandidate: "# Contract\n\n## Objective\n\n...",
      }).version,
    ).toBe(1);
    expect(
      parseProposalApprovalResult({
        proposalId: "proposal-1",
        projectId: "proj-1",
        conversationId: "conv-1",
        approvalId: "approval-1",
        contractCandidate: "# Contract\n\n## Objective\n\n...",
        candidateSha256: "b".repeat(64),
      }).approvalId,
    ).toBe("approval-1");
    expect(parseTranslationTaskResult({ taskId: "task-2" }).taskId).toBe(
      "task-2",
    );
  });
  it("rejects a missing field and a mistyped field on each", () => {
    expect(() =>
      parseProposalCreationResult({
        conversationId: "conv-1",
        proposalId: "proposal-1",
      }),
    ).toThrow();
    expect(() =>
      parseProposalDraftResult({
        proposalId: "proposal-1",
        conversationId: "conv-1",
        state: "owner_review",
        version: "1",
        contractCandidate: "# Contract",
      }),
    ).toThrow();
    expect(() =>
      parseProposalApprovalResult({
        proposalId: "proposal-1",
        projectId: "proj-1",
        conversationId: "conv-1",
        contractCandidate: "# Contract",
        candidateSha256: "b".repeat(64),
      }),
    ).toThrow();
    expect(() => parseTranslationTaskResult({ taskId: 5 })).toThrow();
  });
});

describe("conversation proposal responses (reject and re-fetch)", () => {
  const proposal = {
    id: "proposal-1",
    conversationId: "conv-1",
    projectId: "proj-1",
    version: 2,
    state: "owner_review",
    contractCandidate: "# Contract\n\n## Objective\n\n...",
    candidateSha256: "b".repeat(64),
  };
  it("accepts a proposal with and without an approval id", () => {
    expect(parseConversationProposal(proposal).approvalId).toBeUndefined();
    expect(
      parseConversationProposal({ ...proposal, approvalId: "approval-1" })
        .approvalId,
    ).toBe("approval-1");
  });
  it("rejects a missing field, a mistyped version, and an approval id present but not a string", () => {
    expect(() =>
      parseConversationProposal({ ...proposal, state: undefined }),
    ).toThrow();
    expect(() =>
      parseConversationProposal({ ...proposal, version: "2" }),
    ).toThrow();
    expect(() =>
      parseConversationProposal({ ...proposal, approvalId: 42 }),
    ).toThrow();
  });
});

describe("conversation start and message responses", () => {
  const sampleMessage = {
    id: "msg-1",
    conversationId: "conv-1",
    projectId: "proj-1",
    ordinal: 0,
    role: "assistant",
    content: "Here is a plan.",
    classification: "internal",
    contentSha256: "a".repeat(64),
    createdAt: "2026-08-08T00:00:05Z",
  };
  const attributedMessage = {
    ...sampleMessage,
    sourceTaskId: "task-1",
    modelAttribution: {
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      resolvedModelId: "deepseek-v4-pro",
      costUsdMicros: 12_345,
    },
  };
  it("accepts a realistic conversation-start response", () => {
    expect(
      parseConversationStartResult({
        conversationId: "conv-1",
        projectId: "proj-1",
        title: "Vendor invoice tracker",
        version: 0,
      }).title,
    ).toBe("Vendor invoice tracker");
  });
  it("rejects a missing field and a non-finite version", () => {
    expect(() =>
      parseConversationStartResult({
        conversationId: "conv-1",
        projectId: "proj-1",
        title: "Vendor invoice tracker",
      }),
    ).toThrow();
    expect(() =>
      parseConversationStartResult({
        conversationId: "conv-1",
        projectId: "proj-1",
        title: "Vendor invoice tracker",
        version: Number.NaN,
      }),
    ).toThrow();
  });
  it("accepts a realistic message list and a send-message result wrapping one", () => {
    expect(parseConversationMessageList([attributedMessage])[0]?.role).toBe(
      "assistant",
    );
    expect(
      parseSendMessageResult({
        message: attributedMessage,
        replyTaskId: "task-3",
      }).replyTaskId,
    ).toBe("task-3");
  });
  it("rejects malformed message attribution", () => {
    expect(() =>
      parseConversationMessageList([
        {
          ...attributedMessage,
          modelAttribution: {
            ...attributedMessage.modelAttribution,
            costUsdMicros: "0.01",
          },
        },
      ]),
    ).toThrow();
    expect(() =>
      parseConversationMessageList([
        { ...attributedMessage, sourceTaskId: 42 },
      ]),
    ).toThrow();
  });
  it("rejects a non-array message list, a second element with an unknown role, a missing field, and a wrapped message that fails its own checks", () => {
    // A response that changed shape to {items: [...]} rather than a bare
    // array is exactly the kind of drift this milestone exists to catch.
    expect(() =>
      parseConversationMessageList({ items: [sampleMessage] }),
    ).toThrow();
    expect(() =>
      parseConversationMessageList([
        sampleMessage,
        { ...sampleMessage, id: "msg-2", role: "hacker" },
      ]),
    ).toThrow();
    expect(() =>
      parseConversationMessageList([
        { ...sampleMessage, contentSha256: undefined },
      ]),
    ).toThrow();
    expect(() =>
      parseSendMessageResult({
        message: { ...sampleMessage, ordinal: "0" },
        replyTaskId: "task-3",
      }),
    ).toThrow();
    expect(() =>
      parseSendMessageResult({ message: sampleMessage, replyTaskId: 3 }),
    ).toThrow();
  });
});

describe("conversation history responses", () => {
  const sampleSummary = {
    id: "conv-1",
    projectId: "proj-1",
    title: "Vendor invoice tracker",
    version: 3,
    createdAt: "2026-08-08T00:00:00Z",
  };
  it("accepts a conversation summary and a list mixing active and archived items", () => {
    expect(parseConversationSummary(sampleSummary).version).toBe(3);
    expect(
      parseConversationSummary({
        ...sampleSummary,
        archivedAt: "2026-08-09T00:00:00Z",
      }).archivedAt,
    ).toBe("2026-08-09T00:00:00Z");
    expect(
      parseConversationSummaryList([
        sampleSummary,
        {
          ...sampleSummary,
          id: "conv-2",
          archivedAt: "2026-08-09T00:00:00Z",
        },
      ]),
    ).toHaveLength(2);
  });
  it("rejects a missing field, a non-finite version, an archived-at present but not a string, a non-array list, and one bad element among otherwise-valid ones", () => {
    expect(() =>
      parseConversationSummary({ ...sampleSummary, title: undefined }),
    ).toThrow();
    expect(() =>
      parseConversationSummary({
        ...sampleSummary,
        version: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
    expect(() =>
      parseConversationSummary({ ...sampleSummary, archivedAt: 1 }),
    ).toThrow();
    expect(() => parseConversationSummaryList("not-a-list")).toThrow();
    expect(() =>
      parseConversationSummaryList([
        sampleSummary,
        { ...sampleSummary, id: "conv-2", version: "3" },
      ]),
    ).toThrow();
  });
});

describe("reply task and attachment responses", () => {
  const attachment = {
    id: "att-1",
    conversationId: "conv-1",
    projectId: "proj-1",
    objectKey: "proj-1/att-1",
    displayName: "invoice.pdf",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    sha256: "c".repeat(64),
    state: "scanned",
  };
  it("accepts a realistic reply task status and an attachment with and without a classification", () => {
    expect(
      parseReplyTaskStatus({ taskId: "task-3", state: "succeeded" }).state,
    ).toBe("succeeded");
    expect(parseConversationAttachment(attachment).state).toBe("scanned");
    expect(
      parseConversationAttachment({
        ...attachment,
        classification: "internal",
      }).classification,
    ).toBe("internal");
    expect(parseConversationAttachmentList([attachment])).toHaveLength(1);
  });
  it("rejects a missing field, a mistyped size, a classification present but not a string, and a non-array list", () => {
    expect(() => parseReplyTaskStatus({ taskId: "task-3" })).toThrow();
    expect(() =>
      parseReplyTaskStatus({ taskId: "task-3", state: 7 }),
    ).toThrow();
    expect(() =>
      parseConversationAttachment({ ...attachment, objectKey: undefined }),
    ).toThrow();
    expect(() =>
      parseConversationAttachment({ ...attachment, sizeBytes: "2048" }),
    ).toThrow();
    expect(() =>
      parseConversationAttachment({ ...attachment, classification: 1 }),
    ).toThrow();
    expect(() => parseConversationAttachmentList({ length: 0 })).toThrow();
  });
});

describe("policy command and query responses", () => {
  it("accepts realistic policy lifecycle, override, and active-policy responses", () => {
    expect(
      parsePolicyStateResult({ id: "policy-1", version: 1, state: "draft" })
        .state,
    ).toBe("draft");
    expect(
      parseCodexOverrideResult({
        id: "override-1",
        taskId: "task-4",
        expiresAt: "2026-08-10T00:00:00Z",
      }).taskId,
    ).toBe("task-4");
    expect(
      parseActivePolicy({
        id: "policy-1",
        version: 3,
        state: "active",
        policy: { routesByTaskClass: {} },
      }).version,
    ).toBe(3);
  });
  it("rejects a missing field, a mistyped version, and an unknown-shaped active policy", () => {
    expect(() =>
      parsePolicyStateResult({ id: "policy-1", version: 1 }),
    ).toThrow();
    expect(() =>
      parsePolicyStateResult({
        id: "policy-1",
        version: "1",
        state: "draft",
      }),
    ).toThrow();
    expect(() =>
      parseCodexOverrideResult({ id: "override-1", taskId: "task-4" }),
    ).toThrow();
    expect(() =>
      parseActivePolicy({ id: "policy-1", version: 3, policy: {} }),
    ).toThrow();
  });
});
