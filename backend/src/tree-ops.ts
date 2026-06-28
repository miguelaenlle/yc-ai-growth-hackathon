// tree-ops.ts — All Tree operation implementations.

import { DEAL_VALUE, newId } from "./store.js";
import type {
  Id,
  SignalMetrics,
  TimelineCue,
  TranscriptSegment,
  Traversal,
  Tree,
  TreeNode,
} from "./types.js";

/** Minimum Jaccard similarity score required to match an existing branch node. */
export const BRANCH_THRESHOLD = 0.8;

/**
 * Return the child of `currentNode` (within `tree`) whose title/description
 * text best matches `utterance` using Jaccard token similarity.
 * Returns `{ nodeId, score }` of the best candidate, or `null` when the node
 * has no children.
 */
export function bestMatch(
  tree: Tree,
  currentNodeId: Id,
  utterance: string
): { nodeId: Id; score: number } | null {
  const current = tree.nodes.find((n) => n.id === currentNodeId);
  if (!current || current.childIds.length === 0) return null;

  const tokens = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    const intersection = [...a].filter((t) => b.has(t)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : intersection / union;
  };

  const uttTokens = tokens(utterance);
  let best: { nodeId: Id; score: number } | null = null;

  for (const childId of current.childIds) {
    const child = tree.nodes.find((n) => n.id === childId);
    if (!child) continue;
    const score = jaccard(uttTokens, tokens(`${child.title} ${child.description}`));
    if (!best || score > best.score) best = { nodeId: childId, score };
  }

  return best;
}

// ---------------------------------------------------------------------------
// Supporting types (backend-internal; not part of the API contract)
// ---------------------------------------------------------------------------

/** Summary of every decision made on the path from the tree root to a node. */
export interface DecisionSummary {
  /** Ordered sequence of nodes from root → target (inclusive). */
  path: TreeNode[];
  /** Number of nodes on the path. */
  totalNodes: number;
  /** expectedValue at each node along the path, in the same order as `path`. */
  evProgression: number[];
  /** expectedValue at the target node. */
  finalEV: number;
  /** Highest expectedValue seen anywhere along the path. */
  peakEV: number;
  /** How many conversational turns each speaker contributed along the path. */
  turnCount: { seller: number; buyer: number };
}

/** A node ranked by signal weakness, returned by getWeakNodes. */
export interface WeakNode {
  node: TreeNode;
  /** The metric that most hurt this node's score. */
  worstMetric: keyof SignalMetrics;
  /**
   * The raw metric value driving the weakness ranking.
   * Lower = weaker for confidence/enthusiasm; higher = worse for hesitation.
   */
  score: number;
}

/** Data the caller supplies when creating a new branch node.
 *  The function derives `id`, `expectedValue`, `childIds`, and `parentId`. */
export interface NewNodeData {
  title: string;
  description: string;
  speaker: "seller" | "buyer";
  /** Millisecond offset into the call when this moment occurs. */
  tMs: number;
  /** 0..1 — used to compute expectedValue = round(successProbability * DEAL_VALUE). */
  successProbability: number;
}

/** Returned by routeTranscriptToNode. */
export interface RouteResult {
  /** The node the conversation moved to. Equals `currentNodeId` when no confident match was found. */
  toNodeId: Id;
  /** True when a child / sibling scored >= BRANCH_THRESHOLD. */
  matched: boolean;
  /** Similarity score of the best candidate found (0..1). */
  score: number;
  /** ID of the candidate that scored highest, or null if no candidates exist. */
  matchedNodeId: Id | null;
}

/** Returned by matchOrCreateBranch.
 *  Either the utterance was close enough to an existing child (created: false),
 *  or it forked into a brand-new node (created: true). */
export type BranchDecision =
  | { created: true; node: TreeNode }
  | { created: false; matchedNodeId: Id; score: number };

// ---------------------------------------------------------------------------
// Group 1 — Navigation (pure reads, no mutation)
// ---------------------------------------------------------------------------

/**
 * Look up a single node in `tree` by `nodeId`.
 * Returns `undefined` when the node does not exist.
 */
export function getNodeById(tree: Tree, nodeId: Id): TreeNode | undefined {
  return tree.nodes.find((n) => n.id === nodeId);
}

/**
 * Return the ordered sequence of nodes from the tree root down to `nodeId`
 * (both endpoints inclusive).
 * Returns `[]` when `nodeId` does not exist in the tree.
 */
export function getPathToNode(tree: Tree, nodeId: Id): TreeNode[] {
  const target = getNodeById(tree, nodeId);
  if (!target) return [];

  const path: TreeNode[] = [];
  let current: TreeNode | undefined = target;

  while (current) {
    path.unshift(current);
    if (current.parentId === null) break;
    current = getNodeById(tree, current.parentId);
  }

  return path;
}

/**
 * Return the resolved `TreeNode` objects for every direct child of `nodeId`.
 * Returns `[]` when the node has no children or does not exist.
 */
export function getNodeChildren(tree: Tree, nodeId: Id): TreeNode[] {
  const node = getNodeById(tree, nodeId);
  if (!node) return [];
  return node.childIds
    .map((id) => getNodeById(tree, id))
    .filter((n): n is TreeNode => n !== undefined);
}

/**
 * Return the resolved parent `TreeNode` of `nodeId`, or `null` when `nodeId`
 * is the root (parentId === null) or does not exist.
 */
export function getNodeParent(tree: Tree, nodeId: Id): TreeNode | null {
  const node = getNodeById(tree, nodeId);
  if (!node || node.parentId === null) return null;
  return getNodeById(tree, node.parentId) ?? null;
}

/**
 * Return `nodeId` plus all of its descendants as a flat array (depth-first,
 * pre-order). Returns `[]` when `nodeId` does not exist.
 */
export function getSubtree(tree: Tree, nodeId: Id): TreeNode[] {
  const root = getNodeById(tree, nodeId);
  if (!root) return [];

  const result: TreeNode[] = [];
  const stack: TreeNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    // Push children in reverse so left-most child is processed first
    for (let i = node.childIds.length - 1; i >= 0; i--) {
      const child = getNodeById(tree, node.childIds[i]);
      if (child) stack.push(child);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Group 2 — Analysis (derived values, no mutation)
// ---------------------------------------------------------------------------

/**
 * Summarise every decision made on the path from the tree root to `nodeId`.
 * Used to build mock-session context and walkthrough narration prompts.
 */
export function getDecisionSummary(tree: Tree, nodeId: Id): DecisionSummary {
  const path = getPathToNode(tree, nodeId);
  const evProgression = path.map((n) => n.expectedValue);
  const finalEV = evProgression[evProgression.length - 1] ?? 0;
  const peakEV = evProgression.length > 0 ? Math.max(...evProgression) : 0;
  const turnCount = path.reduce(
    (acc, n) => {
      acc[n.speaker]++;
      return acc;
    },
    { seller: 0, buyer: 0 },
  );

  return {
    path,
    totalNodes: path.length,
    evProgression,
    finalEV,
    peakEV,
    turnCount,
  };
}

/**
 * Return the maximum `expectedValue` across all nodes in the tree.
 * Used by `GET /calls` to populate `CallSummary.bestEV`.
 */
export function getBestEV(tree: Tree): number {
  if (tree.nodes.length === 0) return 0;
  return Math.max(0, ...tree.nodes.map((n) => n.expectedValue));
}

/**
 * Derive the call outcome from the node at `finalNodeId`.
 *
 * Rules (aligned with seed data thresholds):
 *   won  — successProbability >= 0.8
 *   lost — successProbability <= 0.1
 *   open — anything in between, or finalNodeId not found / not a leaf
 */
export function getOutcome(
  tree: Tree,
  finalNodeId: Id
): "won" | "lost" | "open" {
  const node = getNodeById(tree, finalNodeId);
  if (!node) return "open";
  if (node.successProbability >= 0.8) return "won";
  if (node.successProbability <= 0.1) return "lost";
  return "open";
}

/**
 * Return all nodes with poor signal metrics, ranked by a composite weakness
 * score (high hesitation, low confidence, low enthusiasm).
 *
 * @param opts.metric  When provided, rank by that single metric only.
 * @param opts.limit   Cap the result list at this many entries.
 *
 * Used to populate `AiFeedback.practiceTargets`.
 */
export function getWeakNodes(
  tree: Tree,
  opts?: { metric?: keyof SignalMetrics; limit?: number }
): WeakNode[] {
  const scored: WeakNode[] = tree.nodes.map((node) => {
    const { confidence, hesitation, enthusiasm } = node.metrics;

    let worstMetric: keyof SignalMetrics;
    let score: number;

    if (opts?.metric) {
      worstMetric = opts.metric;
      score = opts.metric === "hesitation" ? hesitation : node.metrics[opts.metric];
    } else {
      // Composite: higher = worse. Hesitation hurts, low confidence/enthusiasm hurt.
      const compositeScore = hesitation - confidence - enthusiasm;
      // Identify which single metric is contributing most to weakness
      const hesitationPenalty = hesitation;
      const confidencePenalty = 1 - confidence;
      const enthusiasmPenalty = 1 - enthusiasm;
      if (hesitationPenalty >= confidencePenalty && hesitationPenalty >= enthusiasmPenalty) {
        worstMetric = "hesitation";
      } else if (confidencePenalty >= enthusiasmPenalty) {
        worstMetric = "confidence";
      } else {
        worstMetric = "enthusiasm";
      }
      score = compositeScore;
    }

    return { node, worstMetric, score };
  });

  // Sort descending by score (higher composite score = weaker node)
  scored.sort((a, b) => b.score - a.score);

  return opts?.limit ? scored.slice(0, opts.limit) : scored;
}

/**
 * Find the last common node before two node-ID paths diverge.
 *
 * Returns `null` when:
 *   - The paths are identical.
 *   - One path is a prefix of the other (no fork point exists).
 *   - Either path is empty.
 *
 * Used to highlight "the moment the deal turned" between the real call path
 * and the better practice path.
 */
export function getDivergencePoint(
  tree: Tree,
  pathA: Id[],
  pathB: Id[]
): { nodeId: Id; indexInA: number; indexInB: number } | null {
  if (pathA.length === 0 || pathB.length === 0) return null;

  const minLen = Math.min(pathA.length, pathB.length);
  let lastCommonIndex = -1;

  for (let i = 0; i < minLen; i++) {
    if (pathA[i] === pathB[i]) {
      lastCommonIndex = i;
    } else {
      break;
    }
  }

  // No divergence found (identical prefix up to the shorter path)
  if (lastCommonIndex === -1) return null;
  // The paths never diverge (one is a prefix of the other or identical)
  if (lastCommonIndex === minLen - 1 && pathA[minLen] === pathB[minLen]) return null;
  // If both paths are identical up to minLen and one is longer, that's a prefix — no fork
  if (pathA[lastCommonIndex + 1] === undefined || pathB[lastCommonIndex + 1] === undefined) return null;

  return {
    nodeId: pathA[lastCommonIndex],
    indexInA: lastCommonIndex,
    indexInB: lastCommonIndex,
  };
}

// ---------------------------------------------------------------------------
// Group 3 — Mutation (writes to the tree object in memory; caller must persist)
// ---------------------------------------------------------------------------

/**
 * Create a new `TreeNode` as a child of `parentNodeId`, wire it into
 * `parent.childIds`, and return the created node.
 *
 * Throws when `parentNodeId` does not exist in `tree`.
 * The caller is responsible for calling `putTree` / `persist` afterwards.
 */
export function insertBranchNode(
  tree: Tree,
  parentNodeId: Id,
  data: NewNodeData
): TreeNode {
  const parent = getNodeById(tree, parentNodeId);
  if (!parent) throw new Error(`insertBranchNode: parent node ${parentNodeId} not found`);

  const id = newId("n");
  const node: TreeNode = {
    id,
    parentId: parentNodeId,
    childIds: [],
    title: data.title,
    description: data.description,
    speaker: data.speaker,
    tMs: data.tMs,
    successProbability: data.successProbability,
    expectedValue: Math.round(data.successProbability * DEAL_VALUE),
    metrics: { confidence: 0.5, hesitation: 0.3, enthusiasm: 0.5 },
  };

  tree.nodes.push(node);
  parent.childIds.push(id);

  return node;
}

/**
 * Overwrite the `metrics` field on the node identified by `nodeId`.
 * Returns the updated `TreeNode`.
 * Throws when `nodeId` does not exist in `tree`.
 * The caller is responsible for calling `putTree` / `persist` afterwards.
 */
export function updateNodeMetrics(
  tree: Tree,
  nodeId: Id,
  metrics: SignalMetrics
): TreeNode {
  const node = getNodeById(tree, nodeId);
  if (!node) throw new Error(`updateNodeMetrics: node ${nodeId} not found`);
  node.metrics = { ...metrics };
  return node;
}

// ---------------------------------------------------------------------------
// Group 4 — Tree Engine (routing / traversal logic)
// ---------------------------------------------------------------------------

/**
 * Given a transcript segment, decide whether the conversation moved from
 * `currentNodeId` to one of its children.
 *
 * Uses Jaccard similarity as a cheap stand-in for embedding/LLM scoring.
 * A match is confirmed when `score >= BRANCH_THRESHOLD` (0.8).
 */
export function routeTranscriptToNode(
  tree: Tree,
  currentNodeId: Id,
  segment: TranscriptSegment
): RouteResult {
  const match = bestMatch(tree, currentNodeId, segment.text);

  if (!match) {
    return { toNodeId: currentNodeId, matched: false, score: 0, matchedNodeId: null };
  }

  if (match.score >= BRANCH_THRESHOLD) {
    return {
      toNodeId: match.nodeId,
      matched: true,
      score: match.score,
      matchedNodeId: match.nodeId,
    };
  }

  return {
    toNodeId: currentNodeId,
    matched: false,
    score: match.score,
    matchedNodeId: match.nodeId,
  };
}

/**
 * Given a free-form utterance at `currentNodeId`, decide whether it maps to
 * an existing child node or represents a genuinely new conversational fork.
 *
 * - score >= BRANCH_THRESHOLD → existing match; returns `{ created: false, matchedNodeId, score }`.
 * - score <  BRANCH_THRESHOLD → new fork; calls `insertBranchNode` and returns
 *   `{ created: true, node }`.
 *
 * Backs the `/agent/branch` endpoint.
 */
export function matchOrCreateBranch(
  tree: Tree,
  currentNodeId: Id,
  utterance: string
): BranchDecision {
  const match = bestMatch(tree, currentNodeId, utterance);

  if (match && match.score >= BRANCH_THRESHOLD) {
    return { created: false, matchedNodeId: match.nodeId, score: match.score };
  }

  // Derive a minimal NewNodeData from the utterance text
  const current = getNodeById(tree, currentNodeId);
  const newNodeData: NewNodeData = {
    title: utterance.slice(0, 60),
    description: utterance,
    // New branch speaker is the opposite of the current node's speaker
    speaker: current?.speaker === "seller" ? "buyer" : "seller",
    tMs: 0,
    successProbability: 0.5,
  };

  const node = insertBranchNode(tree, currentNodeId, newNodeData);
  return { created: true, node };
}

// ---------------------------------------------------------------------------
// Group 5 — Walkthrough Utilities
// ---------------------------------------------------------------------------

/**
 * Return ordered nodes along a recording's traversal path (root → each step).
 */
export function getPathFromTraversal(tree: Tree, traversal: Traversal): TreeNode[] {
  const path: TreeNode[] = [];
  const seen = new Set<Id>();

  const root = getNodeById(tree, traversal.initialNodeId);
  if (root) {
    path.push(root);
    seen.add(root.id);
  }

  for (const step of traversal.steps) {
    const node = getNodeById(tree, step.toNodeId);
    if (node && !seen.has(node.id)) {
      path.push(node);
      seen.add(node.id);
    }
  }

  return path;
}

/**
 * Sibling branches the rep did not take at a seller decision node.
 */
export function getDecisionAlternatives(
  tree: Tree,
  nodeId: Id,
  _pathNodeIds: Set<Id>
): TreeNode[] {
  const node = getNodeById(tree, nodeId);
  if (!node || node.speaker !== "seller") return [];
  const parent = getNodeParent(tree, nodeId);
  if (!parent) return [];
  return getNodeChildren(tree, parent.id).filter((n) => n.id !== nodeId);
}

/**
 * Map a recording's traversal steps to a `TimelineCue[]` for audio sync.
 * Each cue marks the millisecond offset (`atMs`) at which the narration
 * should highlight a particular node (`nodeId`).
 *
 * Used by `GET /recordings/:id/walkthrough` to build `WalkthroughBundle.timeline`.
 */
export function buildWalkthroughTimeline(traversal: Traversal): TimelineCue[] {
  return traversal.steps.map((s) => ({ atMs: s.tMs, nodeId: s.toNodeId }));
}
