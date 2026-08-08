import { parseLiveEvent, parseLiveSnapshot } from "./validation.js";
import type { LiveEvent, LiveSnapshot } from "./types.js";
export async function loadLiveSnapshot(signal?: AbortSignal) {
  const response = await fetch("/api/v1/factory-live/snapshot", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("Factory Live snapshot unavailable");
  return parseLiveSnapshot(await response.json());
}
export function connectLiveEvents(
  snapshot: LiveSnapshot,
  onEvent: (event: LiveEvent) => void,
  onGapOrError: () => void,
) {
  const stream = new EventSource(
    `/api/v1/factory-live/events?after=${snapshot.sequence}`,
    { withCredentials: true },
  );
  stream.onmessage = (message) => {
    try {
      onEvent(parseLiveEvent(JSON.parse(message.data) as unknown, snapshot));
    } catch {
      onGapOrError();
    }
  };
  stream.onerror = onGapOrError;
  return () => stream.close();
}
