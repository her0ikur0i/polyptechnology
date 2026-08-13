import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { RunsPage } from "../../src/dashboard/runs-page.js";
import type { DashboardSnapshot } from "../../src/dashboard/types.js";

const snapshot: DashboardSnapshot = {
  attention: {
    data: [],
    observedAt: "2025-04-13T00:00:00Z",
    freshness: "fresh",
    source: "test",
    issues: [],
  },
  projects: {
    data: [],
    observedAt: "2025-04-13T00:00:00Z",
    freshness: "fresh",
    source: "test",
    issues: [],
  },
  contracts: {
    data: [
      {
        id: "CONTRACT-019",
        title: "Contract 019",
        milestone: "M7",
        state: "active",
        gateStatus: "open",
        publishedSha: "abcd1234",
        taskIds: ["task-1"],
      },
    ],
    observedAt: "2025-04-13T00:00:00Z",
    freshness: "fresh",
    source: "test",
    issues: [],
  },
  attempts: {
    data: [
      {
        id: "attempt-1",
        provider: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        resolvedModelId: "deepseek-v4-pro",
        resolutionSource: "provider_response",
        role: "implementer",
        outcome: "failed",
        inputTokens: 100,
        outputTokens: 200,
        reasoningTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 20,
        costUsdMicros: 12345,
        verified: false,
        artifactSha256: "abcd1234",
        failureCode: "syntax_error",
        taskId: "task-1",
        attemptOrdinal: 1,
      },
    ],
    observedAt: "2025-04-13T00:00:00Z",
    freshness: "fresh",
    source: "test",
    issues: [],
  },
  approvals: {
    data: [],
    observedAt: "2025-04-13T00:00:00Z",
    freshness: "fresh",
    source: "test",
    issues: [],
  },
  telegram: {
    data: {
      authorizedChatIds: [],
      authorizedUserIds: [],
      configurationReady: false,
      liveProbeState: "not_run",
      approvalRequiredForProbe: false,
      webhookRegistered: false,
    },
    observedAt: "2025-04-13T00:00:00Z",
    freshness: "fresh",
    source: "test",
    issues: [],
  },
  sequence: {
    data: {
      state: "running",
      contractId: "CONTRACT-019",
      milestoneId: "M7",
      heartbeatAt: "2025-04-13T00:00:00Z",
      ownerBlockers: 0,
    },
    observedAt: "2025-04-13T00:00:00Z",
    freshness: "fresh",
    source: "test",
    issues: [],
  },
  commandPolicy: {
    csrfToken: "csrf-test-token",
    canConfigureTelegram: false,
  },
};

describe("RunsPage", () => {
  it("renders contract and attempt details", () => {
    render(<RunsPage snapshot={snapshot} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Runs" }),
    ).toBeInTheDocument();

    const bodyText = document.body.textContent ?? "";

    expect(bodyText).toContain("Runs");
    expect(bodyText).toContain("CONTRACT-019");
    expect(bodyText).toContain("task-1");
    expect(bodyText).toContain("attempt-1");
    expect(bodyText).toContain("deepseek-v4-pro");
    expect(bodyText).toContain("Not verified");
    expect(bodyText).toContain("syntax_error");
    expect(bodyText).toContain("abcd1234");
    expect(bodyText).toContain("$0.012345");
  });
});
