import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardApp } from "../../src/dashboard/app.js";
import { StatePage } from "../../src/dashboard/components.js";
import type { DashboardSnapshot } from "../../src/dashboard/types.js";
class MockEventSource {
  static instances: MockEventSource[] = [];
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener() {
    // The composer test keeps the stream open until Stop is clicked.
  }

  close() {
    this.closed = true;
  }
}
const observed = <T,>(data: T) => ({
  data,
  observedAt: "2026-08-08T00:00:00.000Z",
  freshness: "fresh" as const,
  source: "test fixture",
  issues: [],
});
const snapshot: DashboardSnapshot = {
  attention: observed([]),
  projects: observed([]),
  contracts: observed([]),
  attempts: observed([
    {
      id: "a1",
      provider: "deepseek",
      requestedModelId: "deepseek-v4-pro",
      resolvedModelId: "deepseek-v4-pro",
      resolutionSource: "provider_response",
      role: "backend-coder",
      outcome: "succeeded",
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      costUsdMicros: 9,
      verified: true,
    },
  ]),
  approvals: observed([]),
  telegram: observed({
    secretRef: "secret://polyp/telegram/bot-token",
    authorizedChatIds: [],
    authorizedUserIds: [],
    configurationReady: false,
    liveProbeState: "not_run",
    approvalRequiredForProbe: true,
    webhookRegistered: false,
  }),
  sequence: observed({
    state: "running",
    contractId: "CONTRACT-007",
    milestoneId: "M3",
    ownerBlockers: 0,
  }),
  commandPolicy: { csrfToken: "test-csrf", canConfigureTelegram: true },
};
describe("dashboard", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));
  afterEach(() => vi.unstubAllGlobals());
  it("renders real empty and sequence states without invented metrics", () => {
    render(<DashboardApp initialSnapshot={snapshot} />);
    expect(
      screen.getByRole("heading", { name: "Factory overview" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No records reported by test fixture."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("CONTRACT-007 · M3").length).toBeGreaterThan(0);
  });
  it("shows concrete model tracking and reference-only Telegram configuration", async () => {
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(
      screen.getByRole("link", { name: /Providers & Models/ }),
    );
    expect(screen.getAllByText("deepseek-v4-pro")).toHaveLength(2);
    expect(screen.getByLabelText("Verified")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /Settings/ }));
    await screen.findByRole("heading", { name: "Settings" });
    const input = await screen.findByLabelText(/Bot secret reference/);
    expect(input).toHaveValue("secret://polyp/telegram/bot-token");
    expect(input).not.toHaveAttribute("readonly");
    expect(
      screen.getByRole("button", { name: "Save Telegram configuration" }),
    ).toBeEnabled();
    expect(
      screen.getByText(/Owner approval required before a paid probe/),
    ).toBeInTheDocument();
  });
  it("exposes stale provenance and has no automated accessibility violations", async () => {
    const stale = structuredClone(snapshot);
    stale.attention.freshness = "stale";
    stale.attention.issues = ["Event stream delayed."];
    render(<DashboardApp initialSnapshot={stale} />);
    expect(screen.getByRole("status")).toHaveTextContent("Stale data observed");
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((item) => item.id)).toEqual([]);
  });
  it("renders the Policy page with no automated accessibility violations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("no policy active in this test")),
    );
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(screen.getByRole("link", { name: /Policy/ }));
    await screen.findByRole("heading", { name: "Orchestration Policy" });
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((item) => item.id)).toEqual([]);
  });
  it("renders the Orchestrator conversation workspace with no automated accessibility violations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/v1/orchestrator/conversations")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              conversationId: "conversation-1",
              projectId: "project-1",
              title: "Vendor invoice tracker",
              version: 0,
            }),
          });
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(screen.getByRole("link", { name: /Orchestrator/ }));
    // findBy, not getBy: the workspace is a code-split chunk (CONTRACT-015 M6),
    // so navigating to it now crosses a Suspense boundary the owner also waits
    // on. A synchronous query here would assert against the loading fallback.
    await userEvent.type(
      await screen.findByLabelText("Conversation title"),
      "Vendor invoice tracker",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByLabelText("Message");
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((item) => item.id)).toEqual([]);
  });
  it("renders explicit loading, unauthorized, and error states", () => {
    const { rerender } = render(<StatePage kind="loading" />);
    expect(screen.getByText(/Loading verified/)).toBeInTheDocument();
    rerender(<StatePage kind="unauthorized" />);
    expect(
      screen.getByRole("heading", { name: "Owner access required" }),
    ).toBeInTheDocument();
    rerender(<StatePage kind="error" message="Snapshot failed." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Snapshot failed.");
  });
  it("removes the closed mobile drawer from keyboard navigation and exposes toggle state", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(max-width: 760px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(<DashboardApp initialSnapshot={snapshot} />);
    const aside = document.getElementById("primary-sidebar");
    expect(aside).toHaveAttribute("inert");
    const menu = document.querySelector<HTMLButtonElement>(".menu");
    expect(menu).not.toBeNull();
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu!);
    expect(aside).not.toHaveAttribute("inert");
    expect(menu).toHaveAttribute("aria-expanded", "true");
  });
  it("starts a conversation through the authenticated CSRF command boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/conversations/") || url.endsWith("/conversations"))
          return Promise.resolve({
            ok: true,
            json: async () =>
              url === "/api/v1/orchestrator/conversations"
                ? {
                    conversationId: "conversation-1",
                    projectId: "project-bootstrapped",
                    title: "Vendor invoice tracker",
                    version: 0,
                  }
                : [],
          });
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(screen.getByRole("link", { name: /Orchestrator/ }));
    // findBy, not getBy: the workspace is a code-split chunk (CONTRACT-015 M6),
    // so navigating to it now crosses a Suspense boundary the owner also waits
    // on. A synchronous query here would assert against the loading fallback.
    await userEvent.type(
      await screen.findByLabelText("Conversation title"),
      "Vendor invoice tracker",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByLabelText("Message")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/orchestrator/conversations",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "test-csrf" }),
      }),
    );
  });
  it("shows assistant model attribution and ledger cost in the thread", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/v1/orchestrator/conversations")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              conversationId: "conversation-1",
              projectId: "project-1",
              title: "Vendor invoice tracker",
              version: 0,
            }),
          });
        if (url.includes("/projects/project-1/conversations"))
          return Promise.resolve({
            ok: true,
            json: async () => [
              {
                id: "conversation-1",
                projectId: "project-1",
                title: "Vendor invoice tracker",
                version: 1,
                createdAt: "2026-08-13T00:00:00.000Z",
              },
            ],
          });
        if (url.includes("/messages?"))
          return Promise.resolve({
            ok: true,
            json: async () => [
              {
                id: "message-1",
                conversationId: "conversation-1",
                projectId: "project-1",
                ordinal: 1,
                role: "assistant",
                content: "Ready.",
                classification: "internal",
                contentSha256: "0".repeat(64),
                createdAt: "2026-08-13T00:00:00.000Z",
                sourceTaskId: "task-1",
                modelAttribution: {
                  provider: "deepseek",
                  requestedModelId: "deepseek-v4-pro",
                  resolvedModelId: "deepseek-v4-pro",
                  costUsdMicros: 12_345,
                },
              },
            ],
          });
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(screen.getByRole("link", { name: /Orchestrator/ }));
    await userEvent.type(
      await screen.findByLabelText("Conversation title"),
      "Vendor invoice tracker",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Vendor invoice tracker" }),
    );
    expect(
      await screen.findByText("deepseek · deepseek-v4-pro · $0.012345"),
    ).toBeInTheDocument();
  });
  it("supports composer send semantics, stop, regenerate, edit, and draft recovery", async () => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    const serverMessages: Array<{
      id: string;
      conversationId: string;
      projectId: string;
      ordinal: number;
      role: "owner" | "assistant" | "system";
      content: string;
      classification: string;
      contentSha256: string;
      createdAt: string;
    }> = [];
    const sentBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/v1/orchestrator/conversations")
          return new Response(
            JSON.stringify({
              conversationId: "conversation-1",
              projectId: "project-1",
              title: "Vendor invoice tracker",
              version: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        if (url.includes("/messages?"))
          return new Response(JSON.stringify(serverMessages), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.endsWith("/messages") && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          sentBodies.push(body);
          if (String(body.content).includes("will fail"))
            return new Response(JSON.stringify({ error: "nope" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          const message = {
            id: `message-${serverMessages.length + 1}`,
            conversationId: "conversation-1",
            projectId: "project-1",
            ordinal: serverMessages.length + 1,
            role: "owner" as const,
            content: String(body.content),
            classification: "internal",
            contentSha256: "0".repeat(64),
            createdAt: "2026-08-13T00:00:00.000Z",
          };
          serverMessages.push(message);
          return new Response(
            JSON.stringify({
              message,
              replyTaskId: "00000000-0000-4000-8000-000000000101",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/00000000-0000-4000-8000-000000000101/cancel"))
          return new Response(
            JSON.stringify({
              taskId: "00000000-0000-4000-8000-000000000101",
              state: "cancelled",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(screen.getByRole("link", { name: /Orchestrator/ }));
    await userEvent.type(
      await screen.findByLabelText("Conversation title"),
      "Vendor invoice tracker",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const composer = await screen.findByLabelText("Message");

    await userEvent.type(composer, "will fail");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The command was not accepted.",
    );
    expect(composer).toHaveValue("will fail");

    await userEvent.clear(composer);
    await userEvent.type(composer, "First draft");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(composer).toHaveValue("First draft\n");
    await userEvent.type(composer, " line two");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText(/First draft/)).toBeInTheDocument();
    expect(MockEventSource.instances[0]?.url).toContain(
      "/api/v1/orchestrator/reply-tasks/00000000-0000-4000-8000-000000000101/stream",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/orchestrator/reply-tasks/00000000-0000-4000-8000-000000000101/cancel",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "test-csrf" }),
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(composer).toHaveValue("First draft\n line two");
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(
      sentBodies.filter((body) =>
        String((body as { content?: unknown }).content).includes("First draft"),
      ),
    ).toHaveLength(2);
  });
  it("keeps following an active reply when Stop fails", async () => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    const serverMessages = [
      {
        id: "message-1",
        conversationId: "conversation-1",
        projectId: "project-1",
        ordinal: 1,
        role: "owner" as const,
        content: "Still running",
        classification: "internal",
        contentSha256: "0".repeat(64),
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/v1/orchestrator/conversations")
          return new Response(
            JSON.stringify({
              conversationId: "conversation-1",
              projectId: "project-1",
              title: "Vendor invoice tracker",
              version: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        if (url.includes("/messages?"))
          return new Response(JSON.stringify(serverMessages), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.endsWith("/messages") && init?.method === "POST")
          return new Response(
            JSON.stringify({
              message: serverMessages[0],
              replyTaskId: "00000000-0000-4000-8000-000000000202",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        if (url.endsWith("/00000000-0000-4000-8000-000000000202/cancel"))
          return new Response(JSON.stringify({ error: "still running" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(screen.getByRole("link", { name: /Orchestrator/ }));
    await userEvent.type(
      await screen.findByLabelText("Conversation title"),
      "Vendor invoice tracker",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const composer = await screen.findByLabelText("Message");
    await userEvent.type(composer, "Still running");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.click(stop);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The command was not accepted.",
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(MockEventSource.instances[0]?.closed).toBe(false);
  });
  it("drafts a policy through the authenticated CSRF command boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/active"))
          return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: "policy-1",
            version: 1,
            state: "draft",
          }),
        });
      }),
    );
    render(<DashboardApp initialSnapshot={snapshot} />);
    await userEvent.click(screen.getByRole("link", { name: /Policy/ }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Create draft" }),
    );
    expect(await screen.findByText(/policy-1/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/policy/draft",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "test-csrf" }),
      }),
    );
  });
});
