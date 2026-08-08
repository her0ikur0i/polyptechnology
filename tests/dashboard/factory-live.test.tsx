import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactoryLive } from "../../src/dashboard/factory-live/FactoryLive.js";
import type { LiveEvent } from "../../src/dashboard/factory-live/types.js";
import { liveSnapshot } from "./factory-live-fixture.js";

const context = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  fillRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  fillText: vi.fn(),
};

describe("Factory Live accessible read-only view", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it("exposes equivalent semantic hierarchy and local inspection", async () => {
    render(<FactoryLive snapshot={liveSnapshot} />);
    expect(
      screen.getByRole("heading", { name: "Factory Live" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(
      liveSnapshot.nodes.length,
    );
    fireEvent.click(screen.getByRole("button", { name: /Renderer/ }));
    expect(
      screen.getByRole("heading", { name: "Renderer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /authoritative record/ }),
    ).toHaveAttribute("href", "/tasks/task");
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((item) => item.id)).toEqual([]);
  });

  it("renders an explicit gap and replay position without workflow controls", () => {
    const gap: LiveEvent = {
      id: "event-9",
      streamId: "stream-1",
      sequence: 9,
      occurredAt: "2026-08-08T01:02:00.000Z",
      type: "node_state",
      nodeId: "task",
      state: "failure",
    };
    render(
      <FactoryLive snapshot={liveSnapshot} events={[gap]} replaySequence={9} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "expected 8, received 9",
    );
    expect(screen.getByText(/Replay · #9/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve|start|stop|retry/i }),
    ).not.toBeInTheDocument();
  });
});
