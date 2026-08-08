import {
  LIVE_CAPS,
  type LiveEvent,
  type LiveNode,
  type LiveSnapshot,
} from "./types.js";
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 300;
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const kinds = new Set([
    "factory",
    "project",
    "contract",
    "milestone",
    "agent",
    "task",
    "artifact",
  ]),
  states = new Set(["idle", "busy", "approval", "success", "failure", "stale"]),
  relations = new Set(["contains", "delegates", "returns"]);
export function parseLiveSnapshot(value: unknown): LiveSnapshot {
  if (
    !record(value) ||
    !text(value.streamId) ||
    !integer(value.structureVersion) ||
    !integer(value.sequence) ||
    !timestamp(value.observedAt) ||
    !Array.isArray(value.scopeProjectIds) ||
    !value.scopeProjectIds.every(text) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    value.nodes.length > LIVE_CAPS.nodes ||
    value.edges.length > LIVE_CAPS.edges
  )
    throw new Error("Invalid or oversized Factory Live snapshot");
  const scope = new Set(value.scopeProjectIds as string[]),
    ids = new Set<string>();
  for (const raw of value.nodes) {
    if (
      !record(raw) ||
      !text(raw.id) ||
      ids.has(raw.id) ||
      !text(raw.kind) ||
      !kinds.has(raw.kind) ||
      !text(raw.label) ||
      !text(raw.state) ||
      !states.has(raw.state) ||
      !text(raw.sourceHref) ||
      !String(raw.sourceHref).startsWith("/") ||
      String(raw.sourceHref).startsWith("//") ||
      (raw.kind !== "factory" && raw.projectId === undefined) ||
      (raw.projectId !== undefined &&
        (!text(raw.projectId) || !scope.has(raw.projectId))) ||
      (raw.parentId !== undefined && !text(raw.parentId))
    )
      throw new Error("Invalid Factory Live node");
    ids.add(raw.id);
  }
  for (const raw of value.nodes as unknown as LiveNode[])
    if (raw.parentId && !ids.has(raw.parentId))
      throw new Error("Factory Live orphan node");
  assertAcyclic(value.nodes as unknown as LiveNode[]);
  const edgeIds = new Set<string>();
  for (const raw of value.edges) {
    if (
      !record(raw) ||
      !text(raw.id) ||
      edgeIds.has(raw.id) ||
      !text(raw.sourceId) ||
      !text(raw.targetId) ||
      !ids.has(raw.sourceId) ||
      !ids.has(raw.targetId) ||
      !text(raw.relation) ||
      !relations.has(raw.relation)
    )
      throw new Error("Invalid Factory Live edge");
    edgeIds.add(raw.id);
  }
  return value as unknown as LiveSnapshot;
}
function assertAcyclic(nodes: ReadonlyArray<LiveNode>) {
  const parent = new Map(nodes.map((node) => [node.id, node.parentId]));
  for (const node of nodes) {
    const seen = new Set<string>();
    let id: string | undefined = node.id;
    while (id) {
      if (seen.has(id)) throw new Error("Factory Live hierarchy cycle");
      seen.add(id);
      id = parent.get(id);
    }
  }
}
export function parseLiveEvent(
  value: unknown,
  snapshot: LiveSnapshot,
): LiveEvent {
  if (
    !record(value) ||
    !text(value.id) ||
    value.streamId !== snapshot.streamId ||
    !integer(value.sequence) ||
    !timestamp(value.occurredAt) ||
    !["node_state", "delegated", "evidence_returned"].includes(
      String(value.type),
    ) ||
    !text(value.nodeId) ||
    !snapshot.nodes.some((node) => node.id === value.nodeId) ||
    (value.state !== undefined &&
      (!text(value.state) || !states.has(value.state))) ||
    (value.edgeId !== undefined &&
      (!text(value.edgeId) ||
        !snapshot.edges.some((edge) => edge.id === value.edgeId)))
  )
    throw new Error("Invalid Factory Live event");
  return value as unknown as LiveEvent;
}
