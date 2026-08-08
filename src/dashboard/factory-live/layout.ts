import type { LiveLayout, LiveNode, LiveSnapshot, Point } from "./types.js";
const quantize = (value: number) => Math.round(value * 1000) / 1000;
export function layoutTopology(
  snapshot: LiveSnapshot,
  width: number,
  height: number,
): LiveLayout {
  const w = Math.max(320, width),
    h = Math.max(240, height),
    center = { x: w / 2, y: h / 2 },
    children = new Map<string | undefined, LiveNode[]>();
  for (const node of snapshot.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.id.localeCompare(b.id));
  const positions = new Map<string, Point>(),
    roots = children.get(undefined) ?? [];
  const place = (
    node: LiveNode,
    x: number,
    y: number,
    depth: number,
    spread: number,
  ) => {
    positions.set(node.id, {
      x: quantize(x),
      y: quantize(y),
      depth,
      radius: Math.max(4, 12 - depth * 1.4),
    });
    const nested = children.get(node.id) ?? [],
      ring = Math.min(w, h) * (0.12 + depth * 0.035);
    nested.forEach((child, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, nested.length) + spread;
      place(
        child,
        x + Math.cos(angle) * ring,
        y + Math.sin(angle) * ring,
        depth + 1,
        angle,
      );
    });
  };
  roots.forEach((root, index) => {
    const angle =
        -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, roots.length),
      radius = roots.length === 1 ? 0 : Math.min(w, h) * 0.18;
    place(
      root,
      center.x + Math.cos(angle) * radius,
      center.y + Math.sin(angle) * radius,
      0,
      angle,
    );
  });
  return {
    structureVersion: snapshot.structureVersion,
    width: w,
    height: h,
    positions,
  };
}
export class LayoutCache {
  private version = -1;
  private value?: LiveLayout;
  private topologyBuilds = 0;
  get(snapshot: LiveSnapshot, width: number, height: number) {
    if (!this.value || this.version !== snapshot.structureVersion) {
      this.value = layoutTopology(snapshot, width, height);
      this.version = snapshot.structureVersion;
      this.topologyBuilds++;
    } else if (this.value.width !== width || this.value.height !== height) {
      const scaledWidth = Math.max(320, width),
        scaledHeight = Math.max(240, height),
        xScale = scaledWidth / this.value.width,
        yScale = scaledHeight / this.value.height;
      this.value = {
        ...this.value,
        width: scaledWidth,
        height: scaledHeight,
        positions: new Map(
          [...this.value.positions].map(([id, point]) => [
            id,
            { ...point, x: point.x * xScale, y: point.y * yScale },
          ]),
        ),
      };
    }
    return this.value;
  }
  rebuildCount() {
    return this.topologyBuilds;
  }
}
export function hitTest(layout: LiveLayout, x: number, y: number) {
  let match: string | undefined,
    distance = Infinity;
  for (const [id, point] of layout.positions) {
    const candidate = Math.hypot(point.x - x, point.y - y);
    if (candidate <= point.radius + 8 && candidate < distance) {
      match = id;
      distance = candidate;
    }
  }
  return match;
}
