import { afterEach, describe, expect, it, vi } from "vitest";
import { saveTelegramSettings } from "../../src/dashboard/api.js";
afterEach(() => vi.unstubAllGlobals());
describe("dashboard commands", () => {
  it("sends only reference identities with same-origin credentials and CSRF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          secretRef: "secret://polyp/telegram/bot",
          authorizedChatIds: ["-1001"],
          authorizedUserIds: ["42"],
          configurationReady: true,
          liveProbeState: "not_run",
          approvalRequiredForProbe: true,
          // PUT /api/v1/settings/telegram always includes this (src/control-api/app.ts) --
          // omitting it here was stale fixture drift, not a real response shape.
          webhookRegistered: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await saveTelegramSettings(
      {
        secretRef: "secret://polyp/telegram/bot",
        authorizedChatIds: ["-1001"],
        authorizedUserIds: ["42"],
      },
      "csrf-value",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/settings/telegram",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-value" }),
      }),
    );
  });
  it("rejects raw secrets and malformed identities before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveTelegramSettings(
        {
          secretRef: "raw-secret",
          authorizedChatIds: ["chat"],
          authorizedUserIds: [],
        },
        "csrf",
      ),
    ).rejects.toThrow(/invalid references/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
