import type { Node } from "@xyflow/react";
import { TREE, BASE_W, BASE_H } from "./treeData";
import type { RawNode, CallNodeData } from "./treeData";

// Click a node to focus it: it stays full size, every other node shrinks
// exponentially with its graph distance (hops) from the focused node — and the
// LAYOUT is repacked so gaps (edge lengths) shrink with the nodes.
const FALLOFF = 0.58; // scale multiplier per hop away
const MIN = 0.16; // smallest scale
const H_GAP = 80; // base horizontal gap between levels (at scale 1)
const V_GAP = 26; // base vertical gap between siblings (at scale 1)
const COMPACT_AT = 0.5; // below this scale, drop the description

/** BFS hop count from the selected node over the undirected tree. */
function hopsFrom(selectedId: string): Map<string, number> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  };
  (function walk(n: RawNode) {
    for (const c of n.children ?? []) {
      link(n.id, c.id);
      link(c.id, n.id);
      walk(c);
    }
  })(TREE);

  const hops = new Map<string, number>([[selectedId, 0]]);
  const queue = [selectedId];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = hops.get(cur)!;
    for (const nb of adj.get(cur) ?? []) {
      if (!hops.has(nb)) {
        hops.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  return hops;
}

// Selected node + its parent and direct children (hops 0 and 1) stay full size;
// exponential downsizing begins beyond that.
const scaleFor = (h: number | undefined) =>
  h == null ? MIN : Math.max(MIN, Math.pow(FALLOFF, Math.max(0, h - 1)));

interface Placed {
  x: number; // top-left x
  yc: number; // center y
  w: number;
  h: number;
}

/** Left-to-right layout where each node's box AND the gaps around it scale by
    `scaleOf(id)`. Uses subtree "extents" so a node's reserved vertical band is
    always at least its own height → siblings can never overlap, even when one
    node is much larger than the rest. */
function layout(scaleOf: (id: string) => number): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const extent = new Map<string, number>();

  // Pass 1: each subtree reserves max(own height, stacked children + gaps).
  function measure(node: RawNode): number {
    const s = scaleOf(node.id);
    const h = BASE_H * s;
    const kids = node.children ?? [];
    let e = h;
    if (kids.length) {
      const block =
        kids.reduce((a, c) => a + measure(c), 0) + V_GAP * s * (kids.length - 1);
      e = Math.max(h, block);
    }
    extent.set(node.id, e);
    return e;
  }
  measure(TREE);

  // Pass 2: place each node centered in its band; children block centered too.
  function assign(node: RawNode, x: number, top: number): void {
    const s = scaleOf(node.id);
    const w = BASE_W * s;
    const h = BASE_H * s;
    const e = extent.get(node.id)!;
    out.set(node.id, { x, yc: top + e / 2, w, h });

    const kids = node.children ?? [];
    if (!kids.length) return;
    const block =
      kids.reduce((a, c) => a + extent.get(c.id)!, 0) + V_GAP * s * (kids.length - 1);
    const childX = x + w + H_GAP * s;
    let ct = top + (e - block) / 2;
    for (const c of kids) {
      assign(c, childX, ct);
      ct += extent.get(c.id)! + V_GAP * s;
    }
  }
  assign(TREE, 0, 0);

  return out;
}

export function applyFocus(
  nodes: Node<CallNodeData>[],
  selectedId: string,
): Node<CallNodeData>[] {
  const hops = hopsFrom(selectedId);
  const scaleOf = (id: string) => scaleFor(hops.get(id));
  const placed = layout(scaleOf);

  return nodes.map((n) => {
    const p = placed.get(n.id);
    if (!p) return n;
    const s = scaleOf(n.id);
    return {
      ...n,
      width: p.w,
      height: p.h,
      position: { x: p.x, y: p.yc - p.h / 2 },
      data: { ...n.data, scale: s, compact: s < COMPACT_AT, focused: n.id === selectedId },
    };
  });
}
