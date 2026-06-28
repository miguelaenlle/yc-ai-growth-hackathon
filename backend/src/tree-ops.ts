// tree-ops.ts — Schema contract for all Tree operations.
// Function bodies are stubs; implementations come later.
// Imports from ../types cover all contract shapes.
// Imports from ./tree cover the shared similarity helpers and BRANCH_THRESHOLD.

// NOTE: Since ./tree doesn't exist yet, we will mock these dependencies here.
const DEAL_VALUE = 48000;
const BRANCH_THRESHOLD = 0.8;
function bestMatch() { return null; }
function expectedValue(p: number) { return Math.round(p * DEAL_VALUE); }

import {
  Id,
  SignalMetrics,
  TimelineCue,
  TranscriptSegment,
  Traversal,
  Tree,
  TreeNode,
} from "./types";

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
 * (Wraps store.getNode for symmetry; keeps tree-ops self-contained.)
 */
export function getNodeById(tree: Tree, nodeId: Id): TreeNode | undefined {
  throw new Error("not implemented");
}

/**
 * Return the ordered sequence of nodes from the tree root down to `nodeId`
 * (both endpoints inclusive).
 * Returns `[]` when `nodeId` does not exist in the tree.
 */
export function getPathToNode(tree: Tree, nodeId: Id): TreeNode[] {
  throw new Error("not implemented");
}

/**
 * Return the resolved `TreeNode` objects for every direct child of `nodeId`.
 * Returns `[]` when the node has no children or does not exist.
 */
export function getNodeChildren(tree: Tree, nodeId: Id): TreeNode[] {
  throw new Error("not implemented");
}

/**
 * Return the resolved parent `TreeNode` of `nodeId`, or `null` when `nodeId`
 * is the root (parentId === null) or does not exist.
 */
export function getNodeParent(tree: Tree, nodeId: Id): TreeNode | null {
  throw new Error("not implemented");
}

/**
 * Return `nodeId` plus all of its descendants as a flat array (depth-first,
 * pre-order). Returns `[]` when `nodeId` does not exist.
 */
export function getSubtree(tree: Tree, nodeId: Id): TreeNode[] {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Group 2 — Analysis (derived values, no mutation)
// ---------------------------------------------------------------------------

/**
 * Summarise every decision made on the path from the tree root to `nodeId`.
 * Used to build mock-session context and walkthrough narration prompts.
 */
export function getDecisionSummary(tree: Tree, nodeId: Id): DecisionSummary {
  throw new Error("not implemented");
}

/**
 * Return the maximum `expectedValue` across all nodes in the tree.
 * Used by `GET /calls` to populate `CallSummary.bestEV`.
 */
export function getBestEV(tree: Tree): number {
  throw new Error("not implemented");
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
  throw new Error("not implemented");
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
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Group 3 — Mutation (writes to the tree object in memory; caller must persist)
// ---------------------------------------------------------------------------

/**
 * Create a new `TreeNode` as a child of `parentNodeId`, wire it into
 * `parent.childIds`, and return the created node.
 *
 * The function:
 *   - Generates a unique `id` (opaque string prefixed "n_").
 *   - Sets `parentId = parentNodeId`.
 *   - Sets `childIds = []`.
 *   - Computes `expectedValue = round(data.successProbability * DEAL_VALUE)`.
 *   - Seeds `metrics` with neutral values (0.5 / 0.3 / 0.5).
 *
 * Throws when `parentNodeId` does not exist in `tree`.
 * The caller is responsible for calling `putTree` / `persist` afterwards.
 */
export function insertBranchNode(
  tree: Tree,
  parentNodeId: Id,
  data: NewNodeData
): TreeNode {
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Group 4 — Tree Engine (routing / traversal logic)
// ---------------------------------------------------------------------------

/**
 * Given a transcript segment, decide whether the conversation moved from
 * `currentNodeId` to one of its children (or near siblings).
 *
 * Uses Jaccard similarity as a cheap stand-in for embedding/LLM scoring
 * (swap in a real scorer by replacing the call to `bestMatch`).
 * A match is confirmed when `score >= BRANCH_THRESHOLD` (0.8).
 *
 * Supersedes `deriveStep` in tree.ts — same logic, richer return type.
 */
export function routeTranscriptToNode(
  tree: Tree,
  currentNodeId: Id,
  segment: TranscriptSegment
): RouteResult {
  throw new Error("not implemented");
}

/**
 * Given a free-form utterance at `currentNodeId`, decide whether it maps to
 * an existing child node or represents a genuinely new conversational fork.
 *
 * - score >= BRANCH_THRESHOLD → existing match; returns `{ created: false, matchedNodeId, score }`.
 * - score <  BRANCH_THRESHOLD → new fork; calls `insertBranchNode` and returns
 *   `{ created: true, node }`.
 *
 * Combines `bestMatch` (from tree.ts) with `insertBranchNode` (above).
 * Backs the `/agent/branch` endpoint.
 */
export function matchOrCreateBranch(
  tree: Tree,
  currentNodeId: Id,
  utterance: string
): BranchDecision {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Group 5 — Walkthrough Utilities
// ---------------------------------------------------------------------------

/**
 * Map a recording's traversal steps to a `TimelineCue[]` for audio sync.
 * Each cue marks the millisecond offset (`atMs`) at which the narration
 * should highlight a particular node (`nodeId`).
 *
 * Used by `GET /recordings/:id/walkthrough` to build `WalkthroughBundle.timeline`.
 */
export function buildWalkthroughTimeline(traversal: Traversal): TimelineCue[] {
  throw new Error("not implemented");
}
