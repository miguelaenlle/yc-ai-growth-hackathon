import type { Node } from "@xyflow/react";
import { BASE_W, BASE_H, BASE_CENTERS } from "./treeData";
import type { CallNodeData } from "./treeData";

// Fish-eye: node scale falls off smoothly with distance from the focus point
// (the viewport center). Tunable.
const MAX = 1.0; // scale at the focus
const MIN = 0.4; // scale far away
const SIGMA = 420; // falloff radius (flow units)

export function scaleForDistance(dist: number): number {
  const s = MIN + (MAX - MIN) * Math.exp(-(dist * dist) / (2 * SIGMA * SIGMA));
  return Math.max(MIN, Math.min(MAX, s));
}

/** Return nodes resized by their distance to `focus`, with each node's center
    pinned to its layout center (so edges/spacing stay correct). */
export function applyFisheye(
  baseNodes: Node<CallNodeData>[],
  focus: { x: number; y: number },
): Node<CallNodeData>[] {
  return baseNodes.map((n) => {
    const c = BASE_CENTERS[n.id] ?? {
      x: n.position.x + BASE_W / 2,
      y: n.position.y + BASE_H / 2,
    };
    const dist = Math.hypot(c.x - focus.x, c.y - focus.y);
    const s = scaleForDistance(dist);
    const w = BASE_W * s;
    const h = BASE_H * s;
    return {
      ...n,
      width: w,
      height: h,
      position: { x: c.x - w / 2, y: c.y - h / 2 },
      data: { ...n.data, scale: s },
    };
  });
}
