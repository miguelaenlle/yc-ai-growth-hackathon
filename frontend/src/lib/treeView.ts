import type { Node, Edge } from "@xyflow/react";
import type { CallDetail, TreeNode } from "./types";
import {
  buildView,
  type RawNode,
  type CallNodeData,
  type Actor,
} from "../components/tree/treeData";

export interface TreeView {
  root: RawNode;
  nodes: Node<CallNodeData>[];
  edges: Edge[];
  rootId: string;
}

/**
 * The set of node ids that lie on a *real* recording's traversal — these read as
 * "Real" (the recorded spine); every other node is an AI-explored branch.
 */
function realNodeIds(detail: CallDetail): Set<string> {
  const ids = new Set<string>();
  for (const rec of detail.recordings) {
    if (!rec.isReal) continue;
    const t = rec.traversal;
    if (t.initialNodeId) ids.add(t.initialNodeId);
    if (t.finalNodeId) ids.add(t.finalNodeId);
    for (const step of t.steps) {
      ids.add(step.fromNodeId);
      ids.add(step.toNodeId);
    }
  }
  return ids;
}

/** Convert a flat backend Tree into the nested RawNode tree the layout expects. */
function toRawTree(detail: CallDetail, real: Set<string>): RawNode {
  const byId = new Map<string, TreeNode>(
    detail.tree.nodes.map((n) => [n.id, n]),
  );
  const build = (id: string): RawNode => {
    const n = byId.get(id)!;
    const isReal = real.has(id);
    return {
      id: n.id,
      kind: isReal ? "real" : "ai",
      title: n.title,
      description: n.description,
      success: n.successProbability,
      visits: n.stats?.visits,
      winRate: n.stats?.winRate,
      onPath: isReal,
      children: n.childIds.filter((c) => byId.has(c)).map(build),
    };
  };
  return build(detail.tree.rootNodeId);
}

/** Build the React Flow view (nodes/edges/root) for a fetched CallDetail. */
export function buildTreeView(detail: CallDetail): TreeView {
  const real = realNodeIds(detail);
  const root = toRawTree(detail, real);
  const speakerOf = new Map<string, Actor>(
    detail.tree.nodes.map((n) => [n.id, n.speaker]),
  );
  const { nodes, edges } = buildView(root, (id) => speakerOf.get(id));
  return { root, nodes, edges, rootId: detail.tree.rootNodeId };
}

/** A node a live session grafted onto the tree. */
export interface ExtraNode {
  nodeId: string;
  title: string;
  parentId: string;
}

/**
 * Build the view with extra nodes a live session created grafted in. Each extra
 * is appended and linked into its parent's `childIds` so the layout picks it up.
 */
export function buildTreeViewWithExtras(
  detail: CallDetail,
  extras: ExtraNode[],
): TreeView {
  if (extras.length === 0) return buildTreeView(detail);

  const nodes: TreeNode[] = detail.tree.nodes.map((n) => ({
    ...n,
    childIds: [...n.childIds],
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const ex of extras) {
    if (byId.has(ex.nodeId)) continue;
    const node: TreeNode = {
      id: ex.nodeId,
      parentId: ex.parentId,
      childIds: [],
      title: ex.title,
      description: "",
      speaker: "seller",
      tMs: 0,
      successProbability: 0.5,
      expectedValue: 0,
      metrics: { confidence: 0, hesitation: 0, enthusiasm: 0 },
    };
    nodes.push(node);
    byId.set(node.id, node);
    const parent = byId.get(ex.parentId);
    if (parent && !parent.childIds.includes(ex.nodeId)) {
      parent.childIds.push(ex.nodeId);
    }
  }

  return buildTreeView({ ...detail, tree: { ...detail.tree, nodes } });
}
