import { describe, expect, it } from "vitest";
import {
  applyLiveEvent,
  projectionFromSnapshot,
  replayEvents,
} from "../../src/dashboard/factory-live/events.js";
import { FrameBudget } from "../../src/dashboard/factory-live/frame-budget.js";
import { snapshotIsStale } from "../../src/dashboard/factory-live/FactoryLive.js";
import {
  hitTest,
  LayoutCache,
  layoutTopology,
} from "../../src/dashboard/factory-live/layout.js";
import type {
  LiveEvent,
  LiveState,
} from "../../src/dashboard/factory-live/types.js";
import { LIVE_CAPS } from "../../src/dashboard/factory-live/types.js";
import {
  parseLiveEvent,
  parseLiveSnapshot,
} from "../../src/dashboard/factory-live/validation.js";
import { liveSnapshot } from "./factory-live-fixture.js";

const event = (sequence: number, state: LiveState = "success"): LiveEvent => ({
  id: `event-${sequence}`,
  streamId: liveSnapshot.streamId,
  sequence,
  occurredAt: "2026-08-08T01:01:00.000Z",
  type: "node_state",
  nodeId: "task",
  state,
});

describe("Factory Live bounded contracts", () => {
  it("validates project scope, hierarchy, links, caps, and event references", () => {
    expect(parseLiveSnapshot(structuredClone(liveSnapshot))).toEqual(
      liveSnapshot,
    );
    const outside = structuredClone(liveSnapshot);
    outside.nodes[1]!.projectId = "not-authorized";
    expect(() => parseLiveSnapshot(outside)).toThrow(/node/);
    const cycle = structuredClone(liveSnapshot);
    cycle.nodes[0]!.parentId = "task";
    expect(() => parseLiveSnapshot(cycle)).toThrow(/cycle/);
    const external = structuredClone(liveSnapshot);
    external.nodes[0]!.sourceHref = "https://outside.invalid";
    expect(() => parseLiveSnapshot(external)).toThrow(/node/);
    external.nodes[0]!.sourceHref = "//outside.invalid/path";
    expect(() => parseLiveSnapshot(external)).toThrow(/node/);
    const unscoped = structuredClone(liveSnapshot);
    delete unscoped.nodes[1]!.projectId;
    expect(() => parseLiveSnapshot(unscoped)).toThrow(/node/);
    const oversized = structuredClone(liveSnapshot);
    oversized.nodes = Array.from(
      { length: LIVE_CAPS.nodes + 1 },
      (_, index) => ({
        id: `n-${index}`,
        kind: "task" as const,
        label: "bounded",
        state: "idle" as const,
        sourceHref: "/tasks/bounded",
      }),
    );
    expect(() => parseLiveSnapshot(oversized)).toThrow(/oversized/);
    expect(() =>
      parseLiveEvent({ ...event(8), nodeId: "foreign" }, liveSnapshot),
    ).toThrow(/event/);
  });

  it("makes snapshot freshness deterministic and explicit", () => {
    const observed = Date.parse(liveSnapshot.observedAt);
    expect(snapshotIsStale(liveSnapshot, observed + 59_999)).toBe(false);
    expect(snapshotIsStale(liveSnapshot, observed + 60_001)).toBe(true);
  });

  it("lays out deterministically, caches by structure and viewport, and hit-tests", () => {
    const first = layoutTopology(liveSnapshot, 900, 600);
    const second = layoutTopology(liveSnapshot, 900, 600);
    expect([...first.positions]).toEqual([...second.positions]);
    const cache = new LayoutCache();
    const cached = cache.get(liveSnapshot, 900, 600);
    expect(cache.get(structuredClone(liveSnapshot), 900, 600)).toBe(cached);
    cache.get(liveSnapshot, 700, 500);
    expect(cache.rebuildCount()).toBe(1);
    expect(
      cache.get({ ...liveSnapshot, structureVersion: 5 }, 900, 600),
    ).not.toBe(cached);
    expect(cache.rebuildCount()).toBe(2);
    const project = first.positions.get("project")!;
    expect(hitTest(first, project.x, project.y)).toBe("project");
  });

  it("ignores duplicates, makes gaps explicit, and replays without mutating the snapshot", () => {
    const base = projectionFromSnapshot(liveSnapshot);
    const next = applyLiveEvent(base, event(8));
    expect(next.states.get("task")).toBe("success");
    expect(applyLiveEvent(next, event(8))).toBe(next);
    expect(applyLiveEvent(next, event(10)).gap).toEqual({
      expected: 9,
      received: 10,
    });
    expect(
      replayEvents(liveSnapshot, [event(9, "failure"), event(8)], 8).states.get(
        "task",
      ),
    ).toBe("success");
    expect(liveSnapshot.nodes[2]!.state).toBe("idle");
  });

  it("adapts through 30/15/5 fps and recovers only after sustained low cost", () => {
    const budget = new FrameBudget();
    for (let index = 0; index < 60; index++) budget.record(30);
    expect(budget.current()).toBe(5);
    for (let index = 0; index < 90; index++) budget.record(2);
    expect(budget.current()).toBe(15);
    for (let index = 0; index < 90; index++) budget.record(2);
    expect(budget.current()).toBe(30);
  });
});
