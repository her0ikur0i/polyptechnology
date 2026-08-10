import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardApp } from "../../src/dashboard/app.js";
import { StatePage } from "../../src/dashboard/components.js";
import type { DashboardSnapshot } from "../../src/dashboard/types.js";
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
