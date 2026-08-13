import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelReplyTask,
  saveTelegramSettings,
  subscribeReplyStream,
} from "../../src/dashboard/api.js";
afterEach(() => vi.unstubAllGlobals());

class MockEventSource {
  static instances: MockEventSource[] = [];
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({
      data: JSON.stringify(data),
    } as MessageEvent);
  }

  close() {
    this.closed = true;
  }
}

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
  it("subscribes to reply chunk streams and closes on terminal state", () => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    const chunks: string[] = [];
    const done: string[] = [];
    const subscription = subscribeReplyStream(
      "00000000-0000-4000-8000-000000000001",
      {
        onChunk: (chunk) => chunks.push(`${chunk.ordinal}:${chunk.fragment}`),
        onDone: (event) => done.push(event.state),
        onError: (error) => {
          throw error;
        },
      },
      7,
    );
    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe(
      "/api/v1/orchestrator/reply-tasks/00000000-0000-4000-8000-000000000001/stream?after=7",
    );
    source.emit("chunk", { ordinal: 8, fragment: "hello" });
    source.emit("done", { state: "succeeded" });
    expect(chunks).toEqual(["8:hello"]);
    expect(done).toEqual(["succeeded"]);
    expect(source.closed).toBe(true);
    subscription.close();
  });
  it("surfaces server retry cursors and closes the current stream", () => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    const retries: number[] = [];
    subscribeReplyStream(
      "00000000-0000-4000-8000-000000000002",
      {
        onChunk: () => {},
        onDone: () => {},
        onRetry: (event) => retries.push(event.after),
        onError: (error) => {
          throw error;
        },
      },
      4,
    );
    const source = MockEventSource.instances[0]!;
    source.emit("retry", { after: 9 });
    expect(retries).toEqual([9]);
    expect(source.closed).toBe(true);
  });

  it("cancels reply tasks through the authenticated command boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          taskId: "00000000-0000-4000-8000-000000000003",
          state: "cancelled",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      cancelReplyTask("00000000-0000-4000-8000-000000000003", "csrf"),
    ).resolves.toEqual({
      taskId: "00000000-0000-4000-8000-000000000003",
      state: "cancelled",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/orchestrator/reply-tasks/00000000-0000-4000-8000-000000000003/cancel",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf" }),
      }),
    );
  });
});
