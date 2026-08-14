import type { LiveLayout, LiveNode, LiveSnapshot, Point } from "./types.js";
const quantize = (value: number) => Math.round(value * 1000) / 1000;
// A stable pseudo-depth per node (hash of id, widened by hierarchy depth) so
// the mesh is deterministic across renders yet reads as three-dimensional.
function zFor(id: string, depth: number): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++)
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  const spread = 70 + depth * 45;
  return ((Math.abs(hash) % 1000) / 1000 - 0.5) * 2 * spread;
}
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
      z: quantize(zFor(node.id, depth)),
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
export interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
  radius: number;
}
// Rotates a node's (x, z) plane around the vertical axis and applies a light
// perspective scale. Depth is returned so the renderer can sort back-to-front.
export function projectPoint(
  point: Point,
  centerX: number,
  rotation: number,
): ProjectedPoint {
  const dx = point.x - centerX;
  const cos = Math.cos(rotation),
    sin = Math.sin(rotation);
  const rotX = dx * cos - point.z * sin;
  const rotZ = dx * sin + point.z * cos;
  const scale = 1 + rotZ / 1600;
  return {
    x: centerX + rotX,
    y: point.y,
    depth: rotZ,
    radius: Math.max(3, point.radius * scale),
  };
}
export function hitTest(
  layout: LiveLayout,
  x: number,
  y: number,
  rotation = 0,
) {
  const centerX = layout.width / 2;
  let match: string | undefined,
    distance = Infinity;
  for (const [id, point] of layout.positions) {
    const projected = projectPoint(point, centerX, rotation);
    const candidate = Math.hypot(projected.x - x, projected.y - y);
    if (candidate <= projected.radius + 8 && candidate < distance) {
      match = id;
      distance = candidate;
    }
  }
  return match;
}
