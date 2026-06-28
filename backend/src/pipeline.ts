// pipeline.ts — Per-segment processing pipeline shared between the HTTP PATCH
// handler and the live WebSocket session handler.
//
// processSegment() is the single place that:
//   1. Routes the segment to a tree node (GPT-based matching for live calls)
//   2. Records a TraversalStep when the node changes
//   3. Computes and stores updated SignalMetrics on the active node
//   4. Emits the appropriate LiveEvents to connected SSE clients

import {
  getNodeById,
  insertBranchNode,
  updateNodeMetrics,
} from "./tree-ops.js";
import { computeMetrics } from "./signal-engine.js";
import { putTree, putRecording, persist, getTree } from "./store.js";
import type { AudioScore } from "./audio/types.js";
import type {
  Id,
  LiveEvent,
  Recording,
  TraversalStep,
  TranscriptSegment,
  Tree,
} from "./types.js";

import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------------------------
// GPT-based branch router
// ---------------------------------------------------------------------------

/**
 * Use gpt-4o-mini to decide whether `utterance` at `currentNodeId` maps to
 * an existing child node or represents a genuinely new conversational fork.
 *
 * Returns:
 *   { matched: true,  toNodeId }  — move to existing child
 *   { matched: false, toNodeId }  — stay at current node (no confident match, no creation)
 *   { created: true,  toNodeId }  — new node was inserted into the tree
 */
// Minimum word count to bother calling GPT for tree routing.
// Very short turns ("yes", "right", "okay") almost never change the node.
const MIN_WORDS_FOR_ROUTING = 5;

async function gptRoute(
  tree: Tree,
  currentNodeId: Id,
  utterance: string,
  recentConversation: { role: string; text: string }[],
): Promise<{ created: boolean; toNodeId: Id }> {
  // Skip GPT call for short/filler utterances — stay at current node
  const wordCount = utterance.trim().split(/\s+/).length;
  if (wordCount < MIN_WORDS_FOR_ROUTING) {
    return { created: false, toNodeId: currentNodeId };
  }

  const current = getNodeById(tree, currentNodeId);
  if (!current) return { created: false, toNodeId: currentNodeId };

  const children = current.childIds
    .map((id) => getNodeById(tree, id))
    .filter(Boolean) as NonNullable<ReturnType<typeof getNodeById>>[];

  // If there are no children yet, always create a new branch.
  if (children.length === 0) {
    const node = insertBranchNode(tree, currentNodeId, {
      title: utterance.slice(0, 60),
      description: utterance,
      speaker: current.speaker === "seller" ? "buyer" : "seller",
      tMs: 0,
      successProbability: 0.5,
    });
    return { created: true, toNodeId: node.id };
  }

  const childList = children
    .map((c, i) => `${i + 1}. id="${c.id}" title="${c.title}" desc="${c.description}"`)
    .join("\n");

  const recentCtx = recentConversation
    .slice(-6)
    .map((m) => `[${m.role.toUpperCase()}]: ${m.text}`)
    .join("\n");

  const prompt = `You are routing a live sales call utterance to a conversation tree node.

RECENT CONVERSATION:
${recentCtx}

LATEST UTTERANCE: "${utterance}"

EXISTING CHILD NODES:
${childList}

Respond with JSON only:
- If the utterance maps to an existing child: { "action": "match", "nodeId": "<id>" }
- If it is a genuinely new direction not covered by any child: { "action": "create", "title": "<10 words max>", "description": "<the utterance summarised in one sentence>" }
- If the utterance is unclear/filler/continuation and should stay at the current node: { "action": "stay" }`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.warn("[pipeline] GPT router failed:", await res.text());
      return { created: false, toNodeId: currentNodeId };
    }

    const data = await res.json() as { choices: { message: { content: string } }[] };
    const result = JSON.parse(data.choices[0].message.content) as {
      action: "match" | "create" | "stay";
      nodeId?: string;
      title?: string;
      description?: string;
    };

    if (result.action === "match" && result.nodeId) {
      const matched = getNodeById(tree, result.nodeId);
      if (matched) return { created: false, toNodeId: result.nodeId };
    }

    if (result.action === "create" && result.title && result.description) {
      const node = insertBranchNode(tree, currentNodeId, {
        title: result.title,
        description: result.description,
        speaker: current.speaker === "seller" ? "buyer" : "seller",
        tMs: 0,
        successProbability: 0.5,
      });
      return { created: true, toNodeId: node.id };
    }
  } catch (e) {
    console.warn("[pipeline] GPT router error:", e);
  }

  return { created: false, toNodeId: currentNodeId };
}

// ---------------------------------------------------------------------------
// processSegment — main export
// ---------------------------------------------------------------------------

/**
 * Process a single transcript segment through the full pipeline:
 * route → record traversal → compute metrics → emit LiveEvents.
 *
 * @param rec        - The recording (mutated in place; caller must persist).
 * @param tree       - The tree (mutated in place if a new node is created).
 * @param seg        - The newly transcribed segment.
 * @param emitFn     - Function to push a LiveEvent to SSE clients.
 * @param recentConversation - Rolling window of recent turns for GPT context.
 * @param audioScore - Optional audio features from the local analyzer.
 */
export async function processSegment(
  rec: Recording,
  tree: Tree,
  seg: TranscriptSegment,
  emitFn: (event: LiveEvent) => void,
  recentConversation: { role: string; text: string }[],
  audioScore?: AudioScore,
): Promise<void> {
  let currentNodeId = rec.traversal.finalNodeId;

  // 1. Route via GPT
  const route = await gptRoute(tree, currentNodeId, seg.text, recentConversation);

  if (route.toNodeId !== currentNodeId) {
    const step: TraversalStep = {
      transcriptIndex: seg.index,
      fromNodeId: currentNodeId,
      toNodeId: route.toNodeId,
      tMs: seg.tStartMs,
    };
    rec.traversal.steps.push(step);
    rec.traversal.finalNodeId = route.toNodeId;
    currentNodeId = route.toNodeId;

    const toNode = getNodeById(tree, currentNodeId);
    if (toNode) {
      if (route.created) {
        emitFn({ type: "branch", node: toNode });
      } else {
        emitFn({ type: "move", step, node: toNode });
      }
    }
  }

  // 2. Compute and store metrics
  const activeNode = getNodeById(tree, currentNodeId);
  if (activeNode) {
    const newMetrics = computeMetrics(seg, activeNode.metrics, audioScore);
    updateNodeMetrics(tree, currentNodeId, newMetrics);
    emitFn({ type: "metrics", nodeId: currentNodeId, metrics: newMetrics });
  }

  // 3. Persist
  putTree(tree);
  putRecording(rec);
  persist();
}
