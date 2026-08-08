import {
  LIVE_CAPS,
  type EventProjection,
  type LiveLayout,
  type LiveSnapshot,
} from "./types.js";
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
export function drawFactory(
  context: CanvasRenderingContext2D,
  snapshot: LiveSnapshot,
  layout: LiveLayout,
  projection: EventProjection,
  nowMs: number,
  motion: boolean,
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
  context.lineWidth = 1;
  for (const edge of snapshot.edges) {
    const source = layout.positions.get(edge.sourceId),
      target = layout.positions.get(edge.targetId);
    if (!source || !target) continue;
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.strokeStyle =
      edge.relation === "returns"
        ? "#45d49a66"
        : edge.relation === "delegates"
          ? "#53d5ff66"
          : "#526a8544";
    context.stroke();
  }
  for (const node of snapshot.nodes) {
    const point = layout.positions.get(node.id);
    if (!point) continue;
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
    if (point.depth < 3) {
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
      const a = layout.positions.get(
          flow.direction === "out" ? edge.sourceId : edge.targetId,
        ),
        b = layout.positions.get(
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
