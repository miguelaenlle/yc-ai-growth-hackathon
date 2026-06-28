import type { Node, Edge } from "@xyflow/react";
import { GEN_TREE, GEN_ACTOR } from "../../data/tree.generated";

// Call Review tree — generated from the one canonical seed (seed/calltree.seed.ts
// → frontend/src/data/tree.generated.ts) so node ids match the backend exactly.
// A real recorded "spine" (the lost hero call) plus AI-explored alternative
// branches, each scored by a success probability. Run `npm run seed` to refresh.

export type Actor = "buyer" | "seller";

export interface CallNodeData {
  kind: "real" | "ai";
  title: string;
  description?: string;
  success?: number; // 0..1, AI nodes only → signal ramp
  visits?: number; // population calls that passed through this move (evidence)
  winRate?: number; // 0..1 — observed win-rate of this move across the population
  onPath?: boolean; // on the real recorded path
  actor?: Actor;
  onSimulate?: () => void; // shown on the focused node → start a simulation here
  onWatch?: () => void; // shown on the focused node → watch the AI ace it from here
  aiRecommended?: boolean; // the LLM-picked "practice from here" node → badge
  marker?: "start" | "breakpoint" | "end"; // simulation role badge
  [key: string]: unknown;
}

// Whose words/decision each node represents — generated alongside the tree.
const ACTOR: Record<string, Actor> = GEN_ACTOR;

export interface RawNode {
  id: string;
  kind: "real" | "ai";
  title: string;
  description?: string;
  success?: number;
  visits?: number;
  winRate?: number;
  onPath?: boolean;
  children?: RawNode[];
}

// ---- The tree — generated from the canonical seed (see import above). -----
export const TREE: RawNode = GEN_TREE;

// ---- Tidy left-to-right layout (center parents over their children's spans) -
const LEVEL_GAP = 300; // horizontal gap per depth level
const SIBLING_GAP = 110; // vertical slot per leaf

// Base node box — the size at full fish-eye scale (s = 1).
export const BASE_W = 240;
export const BASE_H = 104;

interface Positioned {
  node: RawNode;
  cross: number; // vertical position (sibling axis)
  depth: number; // horizontal level
}

function layout(root: RawNode): Positioned[] {
  const out: Positioned[] = [];
  let cursor = 0; // next free leaf slot (in SIBLING_GAP units)

  function place(node: RawNode, depth: number): number {
    if (!node.children || node.children.length === 0) {
      const cross = cursor * SIBLING_GAP;
      cursor += 1;
      out.push({ node, cross, depth });
      return cross;
    }
    const childCross = node.children.map((c) => place(c, depth + 1));
    const cross = (childCross[0] + childCross[childCross.length - 1]) / 2;
    out.push({ node, cross, depth });
    return cross;
  }

  place(root, 0);
  return out;
}

// ---- Derive React Flow nodes + edges --------------------------------------
// Reusable for any RawNode tree — the static seed (TREE) and trees built from
// backend data both flow through here, so visuals stay identical.
export function buildView(
  root: RawNode,
  actorOf: (id: string) => Actor | undefined,
): { nodes: Node<CallNodeData>[]; edges: Edge[] } {
  const positioned = layout(root);
  const nodes: Node<CallNodeData>[] = positioned.map(({ node, cross, depth }) => ({
    id: node.id,
    type: "call",
    position: { x: depth * LEVEL_GAP, y: cross },
    data: {
      kind: node.kind,
      title: node.title,
      description: node.description,
      success: node.success,
      visits: node.visits,
      winRate: node.winRate,
      onPath: node.onPath,
      actor: actorOf(node.id),
      depth,
    },
    width: BASE_W,
    height: BASE_H,
  }));

  const edges: Edge[] = [];
  const walk = (node: RawNode) => {
    for (const child of node.children ?? []) {
      const onPath = node.onPath && child.onPath;
      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        animated: child.kind === "ai",
        style: {
          stroke: onPath ? "var(--color-accent)" : "var(--color-border-strong)",
          strokeWidth: onPath ? 2 : 1.5,
        },
      });
      walk(child);
    }
  };
  walk(root);

  return { nodes, edges };
}

export const { nodes: initialNodes, edges: initialEdges } = buildView(
  TREE,
  (id) => ACTOR[id],
);
export const NODE_COUNT = initialNodes.length;

// Each node's fixed center (from layout) — fish-eye pins centers and only
// varies size, so the tree shape stays stable.
export const BASE_CENTERS: Record<string, { x: number; y: number }> =
  Object.fromEntries(
    initialNodes.map((n) => [
      n.id,
      { x: n.position.x + BASE_W / 2, y: n.position.y + BASE_H / 2 },
    ]),
  );
