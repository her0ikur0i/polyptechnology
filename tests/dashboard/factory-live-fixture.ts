import type { LiveSnapshot } from "../../src/dashboard/factory-live/types.js";

export const liveSnapshot: LiveSnapshot = {
  streamId: "stream-1",
  structureVersion: 4,
  sequence: 7,
  observedAt: "2026-08-08T01:00:00.000Z",
  scopeProjectIds: ["project-1"],
  nodes: [
    {
      id: "factory",
      kind: "factory",
      label: "Factory",
      state: "busy",
      sourceHref: "/factory",
    },
    {
      id: "project",
      parentId: "factory",
      projectId: "project-1",
      kind: "project",
      label: "Project One",
      state: "idle",
      sourceHref: "/projects/project-1",
    },
    {
      id: "task",
      parentId: "project",
      projectId: "project-1",
      kind: "task",
      label: "Renderer",
      state: "idle",
      sourceHref: "/tasks/task",
    },
  ],
  edges: [
    {
      id: "delegate",
      sourceId: "project",
      targetId: "task",
      relation: "delegates",
    },
  ],
};
