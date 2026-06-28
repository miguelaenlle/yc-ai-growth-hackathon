import type { Node, Edge } from "@xyflow/react";
import { TREE, BASE_W, BASE_H } from "./treeData";
import type { RawNode, CallNodeData } from "./treeData";

// Click a node to focus it. The root→selected path is laid out as a straight
// horizontal trunk (y = 0); the selected node's children fan to its right and
// off-path branches stack above/below the trunk. Nodes shrink exponentially
// with graph distance from the selected node; the path stays full size.
const FALLOFF = 0.58; // scale multiplier per hop away
const MIN = 0.45; // smallest scale — keeps small nodes a reasonable size
const H_GAP = 80; // base horizontal gap between levels (at scale 1)
const V_GAP = 26; // base vertical gap between siblings (at scale 1)
const BAND_GAP = 70; // gap between the trunk and stacked off-path branches
const TITLE_ONLY_AT = 0.9; // below this scale, show only the title

function parentMap(): Map<string, string> {
  const m = new Map<string, string>();
  (function walk(n: RawNode) {
    for (const c of n.children ?? []) {
      m.set(c.id, n.id);
      walk(c);
    }
  })(TREE);
  return m;
}

function nodeIndex(): Map<string, RawNode> {
  const m = new Map<string, RawNode>();
  (function walk(n: RawNode) {
    m.set(n.id, n);
    (n.children ?? []).forEach(walk);
  })(TREE);
  return m;
}

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

const scaleFor = (h: number | undefined) =>
  h == null ? MIN : Math.max(MIN, Math.pow(FALLOFF, Math.max(0, h - 1)));

function ancestorSet(selectedId: string, parent: Map<string, string>): Set<string> {
  const set = new Set<string>([selectedId]);
  let cur = selectedId;
  while (parent.has(cur)) {
    cur = parent.get(cur)!;
    set.add(cur);
  }
  return set;
}

/** Ordered path root → selected. */
function pathToRoot(selectedId: string, parent: Map<string, string>): string[] {
  const chain = [selectedId];
  let cur = selectedId;
  while (parent.has(cur)) {
    cur = parent.get(cur)!;
    chain.push(cur);
  }
  return chain.reverse();
}

interface Placed {
  x: number;
  yc: number;
  w: number;
  h: number;
}

function layoutPath(
  scaleOf: (id: string) => number,
  path: string[],
  byId: Map<string, RawNode>,
): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const extent = new Map<string, number>();

  // Subtree extent = max(own height, stacked children + gaps) → no overlap.
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

  // Place an off-trunk subtree, each node centered in its extent band.
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

  // 1. Straight trunk along y = 0.
  const trunkX: number[] = [];
  let x = 0;
  for (const id of path) {
    const s = scaleOf(id);
    trunkX.push(x);
    out.set(id, { x, yc: 0, w: BASE_W * s, h: BASE_H * s });
    x += BASE_W * s + H_GAP * s;
  }

  // 2. Selected node's children fan, centered on the trunk, to its right.
  const selId = path[path.length - 1];
  const sel = byId.get(selId)!;
  const selS = scaleOf(selId);
  const selChildX = trunkX[path.length - 1] + BASE_W * selS + H_GAP * selS;
  const selKids = sel.children ?? [];
  let fanHalf = 0;
  if (selKids.length) {
    const block =
      selKids.reduce((a, c) => a + extent.get(c.id)!, 0) +
      V_GAP * selS * (selKids.length - 1);
    fanHalf = block / 2;
    let ct = -block / 2;
    for (const c of selKids) {
      assign(c, selChildX, ct);
      ct += extent.get(c.id)! + V_GAP * selS;
    }
  }

  // 3. Off-path branches of the ancestor trunk nodes. Each branch keeps the side
  //    it sat on relative to the path: siblings listed BEFORE the path-continuation
  //    child go above, those AFTER go below — so branches land where they were
  //    originally (mostly below, since the path is the first child at each fork).
  //    Global cursors keep the bands disjoint so nothing overlaps.
  let aboveTop = -(fanHalf + BAND_GAP);
  let belowBottom = fanHalf + BAND_GAP;
  for (let i = 0; i < path.length - 1; i++) {
    const node = byId.get(path[i])!;
    const s = scaleOf(path[i]);
    const childX = trunkX[i] + BASE_W * s + H_GAP * s;
    const kids = node.children ?? [];
    const nextIdx = kids.findIndex((c) => c.id === path[i + 1]);

    // Above: nearest the path-child first (closest to trunk), earlier siblings higher.
    for (const b of kids.slice(0, nextIdx).reverse()) {
      const e = extent.get(b.id)!;
      assign(b, childX, aboveTop - e);
      aboveTop -= e + BAND_GAP;
    }
    // Below: nearest the path-child first (closest to trunk), later siblings lower.
    for (const b of kids.slice(nextIdx + 1)) {
      const e = extent.get(b.id)!;
      assign(b, childX, belowBottom);
      belowBottom += e + BAND_GAP;
    }
  }

  return out;
}

export function applyFocus(
  nodes: Node<CallNodeData>[],
  edges: Edge[],
  selectedId: string,
): { nodes: Node<CallNodeData>[]; edges: Edge[] } {
  const parent = parentMap();
  const byId = nodeIndex();
  const hops = hopsFrom(selectedId);
  const ancestors = ancestorSet(selectedId, parent);
  const path = pathToRoot(selectedId, parent);
  const emphasized = new Set<string>([
    ...ancestors,
    ...(byId.get(selectedId)?.children ?? []).map((c) => c.id),
  ]);
  // Selected node is the biggest (clearly the end of the path); ancestors full.
  const scaleOf = (id: string) =>
    id === selectedId ? 1.15 : ancestors.has(id) ? 1 : scaleFor(hops.get(id));
  const opacityOf = (id: string) =>
    emphasized.has(id) ? 1 : Math.max(0.22, Math.min(0.6, scaleOf(id)));
  const placed = layoutPath(scaleOf, path, byId);

  const outNodes = nodes.map((n) => {
    const p = placed.get(n.id);
    if (!p) return n;
    const s = scaleOf(n.id);
    return {
      ...n,
      width: p.w,
      height: p.h,
      position: { x: p.x, y: p.yc - p.h / 2 },
      data: {
        ...n.data,
        scale: s,
        opacity: opacityOf(n.id),
        titleOnly: s < TITLE_ONLY_AT,
        focused: n.id === selectedId,
        onCurrentPath: ancestors.has(n.id),
      },
    };
  });

  const outEdges = edges.map((e) => {
    if (ancestors.has(e.source) && ancestors.has(e.target)) {
      return {
        ...e,
        animated: false,
        style: {
          ...e.style,
          stroke: "var(--color-accent)",
          strokeWidth: 3,
          strokeDasharray: undefined,
          opacity: 1,
          filter: "drop-shadow(0 0 3px rgba(61,214,208,0.65))",
        },
      };
    }
    // Non-path edges: visible neutral dashes, static (no flow) so they read as
    // quiet context rather than competing with the bold accent path.
    const op = Math.min(opacityOf(e.source), opacityOf(e.target));
    return {
      ...e,
      animated: false,
      style: {
        ...e.style,
        stroke: "var(--color-text-faint)",
        strokeWidth: 1.5,
        strokeDasharray: "4 5",
        opacity: Math.max(0.55, op),
      },
    };
  });

  return { nodes: outNodes, edges: outEdges };
}
