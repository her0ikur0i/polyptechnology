import { describe, expect, it } from "vitest";
import { parseDashboardSnapshot } from "../../src/dashboard/validation.js";
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
