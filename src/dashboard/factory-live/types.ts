export const LIVE_CAPS = {
  nodes: 500,
  edges: 1000,
  particles: 600,
  dpr: 2,
} as const;
export type LiveNodeKind =
  | "factory"
  | "project"
  | "contract"
  | "milestone"
  | "agent"
  | "task"
  | "artifact";
export type LiveState =
  "idle" | "busy" | "approval" | "success" | "failure" | "stale";
export interface LiveNode {
  id: string;
  parentId?: string;
  projectId?: string;
  kind: LiveNodeKind;
  label: string;
  state: LiveState;
  sourceHref: string;
}
export interface LiveEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: "contains" | "delegates" | "returns";
}
export interface LiveSnapshot {
  streamId: string;
  structureVersion: number;
  sequence: number;
  observedAt: string;
  scopeProjectIds: ReadonlyArray<string>;
  nodes: ReadonlyArray<LiveNode>;
  edges: ReadonlyArray<LiveEdge>;
}
export interface LiveEvent {
  id: string;
  streamId: string;
  sequence: number;
  occurredAt: string;
  type: "node_state" | "delegated" | "evidence_returned";
  nodeId: string;
  state?: LiveState;
  edgeId?: string;
}
export interface Point {
  x: number;
  y: number;
  depth: number;
  radius: number;
}
export interface LiveLayout {
  structureVersion: number;
  width: number;
  height: number;
  positions: ReadonlyMap<string, Point>;
}
export interface EventProjection {
  streamId: string;
  lastSequence: number;
  gap?: { expected: number; received: number };
  states: ReadonlyMap<string, LiveState>;
  flows: ReadonlyArray<{
    eventId: string;
    edgeId?: string;
    direction: "out" | "in";
  }>;
}
