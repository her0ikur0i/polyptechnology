import type {
  EventProjection,
  LiveEvent,
  LiveSnapshot,
  LiveState,
} from "./types.js";
export function projectionFromSnapshot(
  snapshot: LiveSnapshot,
): EventProjection {
  return {
    streamId: snapshot.streamId,
    lastSequence: snapshot.sequence,
    states: new Map(snapshot.nodes.map((node) => [node.id, node.state])),
    flows: [],
  };
}
export function applyLiveEvent(
  current: EventProjection,
  event: LiveEvent,
): EventProjection {
  if (event.streamId !== current.streamId)
    throw new Error("Factory Live stream mismatch");
  if (event.sequence <= current.lastSequence) return current;
  const expected = current.lastSequence + 1;
  if (event.sequence !== expected)
    return { ...current, gap: { expected, received: event.sequence } };
  if (current.gap) return current;
  const states = new Map(current.states);
  if (event.state) states.set(event.nodeId, event.state);
  const flows =
    event.type === "node_state"
      ? current.flows
      : [
          ...current.flows,
          {
            eventId: event.id,
            ...(event.edgeId ? { edgeId: event.edgeId } : {}),
            direction:
              event.type === "delegated" ? ("out" as const) : ("in" as const),
          },
        ].slice(-600);
  return { ...current, lastSequence: event.sequence, states, flows };
}
export function replayEvents(
  snapshot: LiveSnapshot,
  events: ReadonlyArray<LiveEvent>,
  throughSequence: number,
) {
  let result = projectionFromSnapshot(snapshot);
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence))
    if (event.sequence <= throughSequence)
      result = applyLiveEvent(result, event);
  return result;
}
export function resolvedState(
  nodeId: string,
  fallback: LiveState,
  projection: EventProjection,
) {
  return projection.states.get(nodeId) ?? fallback;
}
