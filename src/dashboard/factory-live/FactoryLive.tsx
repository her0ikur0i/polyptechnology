import { useEffect, useMemo, useRef, useState } from "react";
import { connectLiveEvents, loadLiveSnapshot } from "./api.js";
import { FrameBudget } from "./frame-budget.js";
import {
  applyLiveEvent,
  projectionFromSnapshot,
  resolvedState,
} from "./events.js";
import { hitTest, LayoutCache } from "./layout.js";
import { drawFactory, sizeCanvas } from "./renderer.js";
import type {
  EventProjection,
  LiveEvent,
  LiveNode,
  LiveSnapshot,
} from "./types.js";
export function FactoryLive({
  snapshot,
  events = [],
  replaySequence,
}: {
  snapshot: LiveSnapshot;
  events?: ReadonlyArray<LiveEvent>;
  replaySequence?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    hostRef = useRef<HTMLDivElement>(null),
    cache = useRef(new LayoutCache()),
    budget = useRef(new FrameBudget()),
    // Pseudo-3D rotation, drag-to-rotate with inertia (DESIGN.md §6).
    rotationRef = useRef(0),
    velocityRef = useRef(0),
    dragRef = useRef<
      { startX: number; startRotation: number; lastX: number } | undefined
    >(undefined),
    [selected, setSelected] = useState(snapshot.nodes[0]?.id),
    [inViewport, setInViewport] = useState(true),
    [documentVisible, setDocumentVisible] = useState(!document.hidden),
    [reduced, setReduced] = useState(
      () =>
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  const visible = inViewport && documentVisible,
    stale = snapshotIsStale(snapshot);
  const projection = useMemo(
    () =>
      events
        .filter(
          (event) =>
            replaySequence === undefined || event.sequence <= replaySequence,
        )
        .reduce(applyLiveEvent, projectionFromSnapshot(snapshot)),
    [snapshot, events, replaySequence],
  );
  const selectedNode = snapshot.nodes.find((node) => node.id === selected);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setInViewport(entries[0]?.isIntersecting ?? false),
      { threshold: 0.05 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current,
      host = hostRef.current;
    if (!canvas || !host) return;
    let frame = 0,
      last = 0,
      stopped = false;
    const render = (time: number) => {
      if (stopped) return;
      // Inertia: after a drag ends, keep the mesh rotating, decaying to rest.
      if (!dragRef.current && Math.abs(velocityRef.current) > 0.0001) {
        rotationRef.current += velocityRef.current;
        velocityRef.current *= 0.95;
      }
      const rect = host.getBoundingClientRect(),
        width = Math.max(320, Math.floor(rect.width)),
        height = Math.max(360, Math.floor(Math.min(720, width * 0.62)));
      const layout = cache.current.get(snapshot, width, height);
      if (visible && (reduced || time - last >= budget.current.intervalMs())) {
        const start = performance.now(),
          context = sizeCanvas(canvas, width, height, window.devicePixelRatio);
        drawFactory(
          context,
          snapshot,
          layout,
          projection,
          time,
          !reduced && !stale && replaySequence === undefined,
          rotationRef.current,
        );
        budget.current.record(performance.now() - start);
        last = time;
      }
      if (!reduced && !stale && visible) frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [snapshot, projection, reduced, visible, replaySequence, stale]);
  const choose = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect(),
      layout = cache.current.get(snapshot, rect.width, rect.height);
    const id = hitTest(
      layout,
      event.clientX - rect.left,
      event.clientY - rect.top,
      rotationRef.current,
    );
    if (id) setSelected(id);
  };
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = {
      startX: event.clientX,
      startRotation: rotationRef.current,
      lastX: event.clientX,
    };
    velocityRef.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    rotationRef.current =
      drag.startRotation + (event.clientX - drag.startX) / 220;
    velocityRef.current = (event.clientX - drag.lastX) / 220;
    drag.lastX = event.clientX;
  };
  const onPointerUp = () => {
    dragRef.current = undefined;
  };
  return (
    <div className="live-grid">
      <section
        className="live-stage"
        ref={hostRef}
        aria-labelledby="factory-live-heading"
      >
        <header>
          <div>
            <p className="eyebrow">READ-ONLY PROJECTION</p>
            <h1 id="factory-live-heading">Factory Live</h1>
          </div>
          <span className="status status--neutral">
            {replaySequence === undefined
              ? stale
                ? "Stale snapshot · animation paused"
                : "Live projection"
              : `Replay · #${replaySequence}${stale ? " · stale snapshot" : ""}`}
          </span>
        </header>
        {projection.gap && (
          <div className="notice" role="alert">
            Event gap: expected {projection.gap.expected}, received{" "}
            {projection.gap.received}. Snapshot refresh required.
          </div>
        )}
        <canvas
          ref={canvasRef}
          onClick={choose}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Factory topology visualization"
          style={{ cursor: "grab", touchAction: "pan-y" }}
        >
          Factory topology. Drag to rotate; the adjacent semantic hierarchy
          contains the same nodes and states.
        </canvas>
        <p className="live-caption">
          Drag to rotate the mesh. Canvas selection changes inspection only;
          workflow actions remain in authoritative records.
        </p>
      </section>
      <aside
        className="live-inspector"
        aria-label="Factory hierarchy and inspection"
      >
        <h2>Semantic hierarchy</h2>
        <LiveTree
          nodes={snapshot.nodes}
          projection={projection}
          selected={selected}
          onSelect={setSelected}
        />
        {selectedNode && (
          <div className="inspection">
            <p className="eyebrow">SELECTED</p>
            <h3>{selectedNode.label}</h3>
            <dl>
              <div>
                <dt>Kind</dt>
                <dd>{selectedNode.kind}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {resolvedState(
                    selectedNode.id,
                    selectedNode.state,
                    projection,
                  )}
                </dd>
              </div>
            </dl>
            <a href={selectedNode.sourceHref}>Open authoritative record</a>
          </div>
        )}
      </aside>
    </div>
  );
}
export function snapshotIsStale(
  snapshot: LiveSnapshot,
  nowMs = Date.now(),
  maxAgeMs = 60_000,
) {
  return nowMs - Date.parse(snapshot.observedAt) > maxAgeMs;
}
function LiveTree({
  nodes,
  projection,
  selected,
  onSelect,
}: {
  nodes: ReadonlyArray<LiveNode>;
  projection: EventProjection;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  const children = new Map<string | undefined, LiveNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const branch = (parentId?: string) => (
    <ul>
      {(children.get(parentId) ?? []).map((node) => (
        <li key={node.id}>
          <button
            type="button"
            aria-pressed={node.id === selected}
            onClick={() => onSelect(node.id)}
          >
            <span
              className={`node-state node-state--${resolvedState(node.id, node.state, projection)}`}
              aria-hidden="true"
            />
            {node.label}
            <small>
              {node.kind} · {resolvedState(node.id, node.state, projection)}
            </small>
          </button>
          {children.has(node.id) && branch(node.id)}
        </li>
      ))}
    </ul>
  );
  return <div className="live-tree">{branch()}</div>;
}
export function FactoryLivePage() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>();
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void loadLiveSnapshot(controller.signal)
      .then(setSnapshot)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Factory Live unavailable",
          );
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!snapshot) return;
    let closed = false,
      recovering = false,
      expectedSequence = snapshot.sequence;
    const recover = () => {
      if (closed || recovering) return;
      recovering = true;
      setError("Live stream interrupted; refreshing snapshot.");
      void loadLiveSnapshot()
        .then((value) => {
          if (closed) return;
          setSnapshot(value);
          setEvents([]);
          setError(undefined);
        })
        .catch(() => {
          if (!closed) setError("Factory Live recovery snapshot unavailable.");
        })
        .finally(() => {
          recovering = false;
        });
    };
    const disconnect = connectLiveEvents(
      snapshot,
      (event) => {
        if (event.sequence <= expectedSequence) return;
        if (event.sequence !== expectedSequence + 1) {
          recover();
          return;
        }
        expectedSequence = event.sequence;
        setEvents((current) => [...current, event].slice(-600));
      },
      recover,
    );
    return () => {
      closed = true;
      disconnect();
    };
  }, [snapshot]);
  if (error && !snapshot)
    return (
      <div className="state-page" role="alert">
        <h1>Factory Live unavailable</h1>
        <p>{error}</p>
      </div>
    );
  if (!snapshot)
    return (
      <div className="state-page" aria-busy="true">
        <p>Loading Factory Live topology…</p>
      </div>
    );
  return (
    <div className="page">
      {error && (
        <div className="notice" role="status">
          {error}
        </div>
      )}
      <FactoryLive snapshot={snapshot} events={events} />
    </div>
  );
}
