import {
  LIVE_CAPS,
  type EventProjection,
  type LiveLayout,
  type LiveSnapshot,
} from "./types.js";
import { projectPoint, type ProjectedPoint } from "./layout.js";
import { resolvedState } from "./events.js";
const colors = {
  idle: "#8fa3ba",
  busy: "#53d5ff",
  approval: "#f4b95f",
  success: "#45d49a",
  failure: "#ff6f7f",
  stale: "#718096",
} as const;
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
) {
  const ratio = Math.min(LIVE_CAPS.dpr, Math.max(1, dpr));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}
// Renders the factory as a pseudo-3D mesh: the layout's (x, z) plane is rotated
// around the vertical axis by `rotation`, every node is projected through
// projectPoint, and edges/nodes are drawn back-to-front by that projection's
// depth. Canvas 2D only -- no 3D library (system spec §21).
export function drawFactory(
  context: CanvasRenderingContext2D,
  snapshot: LiveSnapshot,
  layout: LiveLayout,
  projection: EventProjection,
  nowMs: number,
  motion: boolean,
  rotation = 0,
) {
  context.clearRect(0, 0, layout.width, layout.height);
  const gradient = context.createRadialGradient(
    layout.width * 0.5,
    layout.height * 0.45,
    0,
    layout.width * 0.5,
    layout.height * 0.45,
    Math.max(layout.width, layout.height) * 0.7,
  );
  gradient.addColorStop(0, "#122844");
  gradient.addColorStop(1, "#07101d");
  context.fillStyle = gradient;
  context.fillRect(0, 0, layout.width, layout.height);

  const centerX = layout.width / 2;
  const projected = new Map<string, ProjectedPoint>();
  for (const node of snapshot.nodes) {
    const point = layout.positions.get(node.id);
    if (point) projected.set(node.id, projectPoint(point, centerX, rotation));
  }

  // The orchestrator is a bright core the clusters radiate from.
  const factory = snapshot.nodes.find((node) => node.kind === "factory");
  const core = factory ? projected.get(factory.id) : undefined;
  if (core) {
    const glow = context.createRadialGradient(
      core.x,
      core.y,
      0,
      core.x,
      core.y,
      core.radius * 7,
    );
    glow.addColorStop(0, "rgba(83,213,255,0.5)");
    glow.addColorStop(0.35, "rgba(83,213,255,0.14)");
    glow.addColorStop(1, "rgba(83,213,255,0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(core.x, core.y, core.radius * 7, 0, Math.PI * 2);
    context.fill();
  }

  // Edges first, depth-sorted back-to-front so nearer trunks draw over farther
  // ones rather than the flat crossings a single pass produces.
  context.lineWidth = 1;
  const edgesByDepth = snapshot.edges.map((edge) => {
    const a = projected.get(edge.sourceId),
      b = projected.get(edge.targetId);
    return { edge, depth: a && b ? (a.depth + b.depth) / 2 : 0 };
  });
  edgesByDepth.sort((a, b) => a.depth - b.depth);
  for (const { edge } of edgesByDepth) {
    const a = projected.get(edge.sourceId),
      b = projected.get(edge.targetId);
    if (!a || !b) continue;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.strokeStyle =
      edge.relation === "returns"
        ? "#45d49a66"
        : edge.relation === "delegates"
          ? "#53d5ff66"
          : "#526a8544";
    context.stroke();
  }

  const nodesByDepth = snapshot.nodes
    .map((node) => ({ node, point: projected.get(node.id) }))
    .filter(
      (
        entry,
      ): entry is {
        node: (typeof snapshot.nodes)[number];
        point: ProjectedPoint;
      } => entry.point !== undefined,
    )
    .sort((a, b) => b.point.depth - a.point.depth);
  for (const { node, point } of nodesByDepth) {
    const state = resolvedState(node.id, node.state, projection);
    context.beginPath();
    context.arc(
      point.x,
      point.y,
      point.radius +
        (motion && state === "busy" ? Math.sin(nowMs / 280) * 1.5 : 0),
      0,
      Math.PI * 2,
    );
    context.fillStyle = colors[state];
    context.shadowColor = colors[state];
    context.shadowBlur = state === "idle" || state === "stale" ? 0 : 14;
    context.fill();
    context.shadowBlur = 0;
    const hierarchyDepth = layout.positions.get(node.id)?.depth ?? 0;
    if (hierarchyDepth < 3) {
      context.fillStyle = "#dce8f5";
      context.font = "11px system-ui";
      context.fillText(
        node.label.slice(0, 36),
        point.x + point.radius + 5,
        point.y + 4,
      );
    }
  }

  if (motion) {
    for (const [index, flow] of projection.flows
      .slice(-LIVE_CAPS.particles)
      .entries()) {
      if (!flow.edgeId) continue;
      const edge = snapshot.edges.find((value) => value.id === flow.edgeId);
      if (!edge) continue;
      const a = projected.get(
          flow.direction === "out" ? edge.sourceId : edge.targetId,
        ),
        b = projected.get(
          flow.direction === "out" ? edge.targetId : edge.sourceId,
        );
      if (!a || !b) continue;
      const progress = (nowMs / 1100 + index * 0.17) % 1;
      context.beginPath();
      context.arc(
        a.x + (b.x - a.x) * progress,
        a.y + (b.y - a.y) * progress,
        2,
        0,
        Math.PI * 2,
      );
      context.fillStyle = flow.direction === "out" ? "#53d5ff" : "#45d49a";
      context.fill();
    }
  }
}
