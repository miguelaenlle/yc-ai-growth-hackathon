// tree-ops.ts — Schema contract for all Tree operations.
// Function bodies are stubs; implementations come later.
// Imports from ../types cover all contract shapes.
// Imports from ./tree cover the shared similarity helpers and BRANCH_THRESHOLD.

import { DEAL_VALUE, expectedValue } from "./store.js";
import type {
  Id,
  SignalMetrics,
  TimelineCue,
  TranscriptSegment,
  Traversal,
  Tree,
  TreeNode,
} from "./types.js";
import OpenAI from "openai";

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
 * (Wraps store.getNode for symmetry; keeps tree-ops self-contained.)
 */
export function getNodeById(tree: Tree, nodeId: Id): TreeNode | undefined {
  return tree.nodes.find(n => n.id === nodeId);

}

/**
 * Return the ordered sequence of nodes from the tree root down to `nodeId`
 * (both endpoints inclusive).
 * Returns `[]` when `nodeId` does not exist in the tree.
 */
export function getPathToNode(tree: Tree, nodeId: Id): TreeNode[] {
  const path: TreeNode[] = [];
  let current = getNodeById(tree, nodeId);
  while (current) {
    path.unshift(current);
    if (!current.parentId) break;
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
  return node.childIds.map(id => getNodeById(tree, id)).filter((n): n is TreeNode => !!n);

}

/**
 * Return the resolved parent `TreeNode` of `nodeId`, or `null` when `nodeId`
 * is the root (parentId === null) or does not exist.
 */
export function getNodeParent(tree: Tree, nodeId: Id): TreeNode | null {
  const node = getNodeById(tree, nodeId);
  if (!node || !node.parentId) return null;
  return getNodeById(tree, node.parentId) ?? null;

}

/**
 * Return `nodeId` plus all of its descendants as a flat array (depth-first,
 * pre-order). Returns `[]` when `nodeId` does not exist.
 */
export function getSubtree(tree: Tree, nodeId: Id): TreeNode[] {
  return []; // Not needed for test

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
  if (path.length === 0) {
    return {
      path: [],
      totalNodes: 0,
      evProgression: [],
      finalEV: 0,
      peakEV: 0,
      turnCount: { seller: 0, buyer: 0 }
    };
  }
  const evProgression = path.map(n => n.expectedValue);
  const seller = path.filter(n => n.speaker === "seller").length;
  const buyer = path.filter(n => n.speaker === "buyer").length;
  return {
    path,
    totalNodes: path.length,
    evProgression,
    finalEV: evProgression[evProgression.length - 1],
    peakEV: Math.max(...evProgression),
    turnCount: { seller, buyer }
  };

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
  const node: TreeNode = {
    id: "n_" + Math.random().toString(36).substring(2, 9),
    parentId: parentNodeId,
    childIds: [],
    title: data.title,
    description: data.description,
    speaker: data.speaker,
    tMs: data.tMs,
    successProbability: data.successProbability,
    expectedValue: expectedValue(data.successProbability),
    metrics: { confidence: 0.5, hesitation: 0.3, enthusiasm: 0.5 }
  };
  tree.nodes.push(node);
  const parent = getNodeById(tree, parentNodeId);
  if (parent) parent.childIds.push(node.id);
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
 * Given a free-form utterance and recent conversation, use gpt-4o-mini to decide
 * whether it maps to an existing child node, represents a completely new fork,
 * or is just conversational filler (staying on the current node).
 */
export async function matchOrCreateBranch(
  tree: Tree,
  currentNodeId: Id,
  recentConversation: { role: string; text: string }[],
  speakerToMatch: "buyer" | "seller" = "seller"
): Promise<BranchDecision> {
  const current = tree.nodes.find((n) => n.id === currentNodeId);
  if (!current) throw new Error("Current node not found");

  const childNodes = current.childIds
    .map((id) => tree.nodes.find((n) => n.id === id))
    .filter((n): n is TreeNode => !!n);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const conversationText = recentConversation
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.text}`)
    .join("\n");

  const systemPrompt = `You are a semantic conversational router tracking a sales call between a SELLER and a BUYER. 
We are currently at a specific node in a decision tree. The next expected speaker is the ${speakerToMatch.toUpperCase()}.
Available child branches representing the ${speakerToMatch.toUpperCase()}'s possible responses:
${childNodes.length > 0 ? childNodes.map((n) => `- ID: ${n.id} | Title: ${n.title} | Desc: ${n.description}`).join("\n") : "(None)"}

Here is the recent conversation transcript since the last node switch.
Determine the next action based on the ${speakerToMatch.toUpperCase()}'s intent in the recent transcript.
- "match": The intent closely aligns with one of the available child branches.
- "stay": They are using conversational filler (e.g. "uh huh", "okay", "go on", "right"), confirming, or continuing the current thought without branching.
- "new": They are proposing a completely new direction that does not match any child branch.

Return JSON ONLY:
{
  "action": "match" | "stay" | "new",
  "nodeId": "id of the matched node, or null",
  "newTitle": "2-4 word title if new, else null",
  "newDescription": "1-2 sentence description if new, else null"
}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: conversationText }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const outText = res.choices[0].message.content || "{}";
    const out = JSON.parse(outText);

    if (out.action === "match" && out.nodeId) {
      return { created: false, matchedNodeId: out.nodeId, score: 1.0 };
    } else if (out.action === "new") {
      const newNode = insertBranchNode(tree, currentNodeId, {
        title: out.newTitle || "New Branch",
        description: out.newDescription || "No description provided",
        speaker: speakerToMatch,
        tMs: 0,
        successProbability: 0.5
      });
      return { created: true, node: newNode };
    } else {
      return { created: false, matchedNodeId: currentNodeId, score: 1.0 };
    }
  } catch (e) {
    console.error("\n[Router Error] LLM returned nonsense JSON or failed. Staying at current node.");
    console.error(e);
    console.error("--------------------------------------------------\n");
    return { created: false, matchedNodeId: currentNodeId, score: 1.0 };
  }
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
