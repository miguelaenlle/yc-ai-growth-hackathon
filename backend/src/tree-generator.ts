// tree-generator.ts — One-shot GPT-4o call tree generation for uploaded MP3 calls.
//
// Takes the full diarized transcript of an uploaded call and a persisted node
// win-rate stat table (store._nodeStats) computed from ALL calls in the store,
// then asks GPT-4o to generate a complete decision tree with:
//   - REAL PATH   — nodes representing what actually happened, in order
//   - AI BRANCHES — 2-3 alternate paths at key divergence points, targeting the
//                   highest win-rate paths found in historical data
//
// The stat table is built by refreshStatCache() and written to seed.json so it
// survives server restarts and grows with every new uploaded call.

import { newId, store, DEAL_VALUE, persist } from "./store.js";
import { getOutcome } from "./tree-ops.js";
import type { AudioScore } from "./audio/types.js";
import type {
  Id,
  NodeStatEntry,
  SignalMetrics,
  TranscriptSegment,
  Tree,
  TreeNode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Stat table builder — scans ALL calls in the store
// ---------------------------------------------------------------------------

function buildNodeStatTable(): NodeStatEntry[] {
  const tally = new Map<string, { wins: number; losses: number }>();

  for (const call of store.calls) {
    const tree = store.trees[call.treeId];
    const rec = Object.values(store.recordings).find(
      (r) => r.callId === call.id && r.isReal,
    );
    if (!tree || !rec) continue;

    const outcome = getOutcome(tree, rec.traversal.finalNodeId);
    if (outcome === "open") continue; // exclude unresolved calls from stats

    const pathIds = [
      rec.traversal.initialNodeId,
      ...rec.traversal.steps.map((s) => s.toNodeId),
    ];

    for (const nid of pathIds) {
      const node = tree.nodes.find((n) => n.id === nid);
      if (!node) continue;
      const entry = tally.get(node.title) ?? { wins: 0, losses: 0 };
      if (outcome === "won") entry.wins++;
      else entry.losses++;
      tally.set(node.title, entry);
    }
  }

  return [...tally.entries()]
    .map(([title, { wins, losses }]) => ({
      title,
      wins,
      losses,
      // Beta-smoothed: prevents 0% / 100% extremes from small samples
      winRate: (wins + 1) / (wins + losses + 2),
      sampleSize: wins + losses,
    }))
    .sort((a, b) => b.sampleSize - a.sampleSize);
}

// ---------------------------------------------------------------------------
// Stat cache — persisted to store._nodeStats / seed.json
// ---------------------------------------------------------------------------

/**
 * Rebuild the node win-rate stat table from all calls in the store and write
 * it to `store._nodeStats` + seed.json. Call this at server startup (if the
 * field is missing) and after every upload pipeline completes.
 */
export function refreshStatCache(): void {
  store._nodeStats = buildNodeStatTable();
  persist();
  console.log(
    `[tree-generator] Stat cache refreshed — ${store._nodeStats.length} node titles from ${store.calls.length} calls`,
  );
}

/**
 * Format the stat table as a compact table string for the GPT prompt.
 * ~200 tokens for 20 rows — negligible cost.
 */
function formatStatTable(stats: NodeStatEntry[]): string {
  const header = "Node Title                    WinRate  Sample";
  const divider = "─".repeat(46);
  const rows = stats
    .map((e) => {
      const pct = `${Math.round(e.winRate * 100)}%`.padStart(7);
      const n = String(e.sampleSize).padStart(6);
      return `${e.title.padEnd(30)}${pct}  ${n}`;
    })
    .join("\n");
  return `${header}\n${divider}\n${rows}`;
}

// ---------------------------------------------------------------------------
// GPT response types (internal)
// ---------------------------------------------------------------------------

interface GptTreeNode {
  title: string;
  description: string;
  speaker: "seller" | "buyer";
  successProbability: number;
  transcriptIndices: number[]; // which transcript segments belong to this node
}

interface GptBranch {
  parentRealPathIndex: number; // index into realPath[]
  nodes: Omit<GptTreeNode, "transcriptIndices">[];
}

interface GptTreeOutput {
  realPath: GptTreeNode[];
  branches: GptBranch[];
}

// ---------------------------------------------------------------------------
// Signal metrics computation for a node's transcript slice
// ---------------------------------------------------------------------------

function metricsForSegments(
  segments: TranscriptSegment[],
  audioScores: Map<number, AudioScore>,
): SignalMetrics {
  if (segments.length === 0) {
    return { confidence: 0.5, hesitation: 0.3, enthusiasm: 0.5 };
  }

  let confidence = 0.5;
  let hesitation = 0.3;
  let enthusiasm = 0.5;

  const WEAK_PATTERNS = [/\buh\b/i, /\bum\b/i, /\bprobably\b/i, /\bmaybe\b/i, /\broadmap\b/i, /\bnot sure\b/i];
  const STRONG_PATTERNS = [/\bsql\b/i, /\bconnector/i, /\bno migration\b/i, /\balternative\b/i, /\bright now\b/i];
  const BUYER_POS = [/\bthat works\b/i, /\bdemo\b/i, /\blet'?s\b/i, /\bbook\b/i, /\bsounds good\b/i];
  const BUYER_NEG = [/\bsend.+deck\b/i, /\bmaybe later\b/i, /\bcircle back\b/i, /\bnot interested\b/i];

  for (const seg of segments) {
    const text = seg.text.toLowerCase();
    const audio = audioScores.get(seg.index);

    if (seg.speaker === "seller") {
      const weak = WEAK_PATTERNS.filter((p) => p.test(text)).length;
      const strong = STRONG_PATTERNS.filter((p) => p.test(text)).length;
      confidence = Math.min(1, Math.max(0, confidence - 0.1 * weak + 0.12 * strong));
      hesitation = Math.min(1, Math.max(0, hesitation + 0.1 * weak - 0.08 * strong));
    } else {
      const pos = BUYER_POS.filter((p) => p.test(text)).length;
      const neg = BUYER_NEG.filter((p) => p.test(text)).length;
      enthusiasm = Math.min(1, Math.max(0, enthusiasm + 0.15 * pos - 0.18 * neg));
    }

    if (audio?.silenceRatio !== undefined) {
      hesitation = Math.min(1, Math.max(0, hesitation + 0.15 * audio.silenceRatio));
    }
    if (audio?.energy !== undefined && audio.energy > 0) {
      confidence = Math.min(1, Math.max(0, confidence + 0.05 * Math.min(1, audio.energy / 0.05)));
    }
  }

  return {
    confidence: Math.round(confidence * 100) / 100,
    hesitation: Math.round(hesitation * 100) / 100,
    enthusiasm: Math.round(enthusiasm * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// GPT call — reads store._nodeStats directly
// ---------------------------------------------------------------------------

async function callGpt(transcript: TranscriptSegment[]): Promise<GptTreeOutput> {
  const transcriptText = transcript
    .map((seg, i) => `[${i}] ${seg.speaker.toUpperCase()}: ${seg.text}`)
    .join("\n");

  // Use persisted stat table; fall back to empty if cache hasn't been seeded yet
  const stats = store._nodeStats ?? [];
  const statTableStr = stats.length > 0
    ? formatStatTable(stats)
    : "No historical data available yet.";

  const wonCount = stats.reduce((s, e) => s + e.wins, 0);
  const lostCount = stats.reduce((s, e) => s + e.losses, 0);

  const prompt = `You are a sales call analyst for a B2B SaaS company (the seller is Slack).

Your job is to generate a decision tree for the following uploaded sales call recording.

The tree must have:
1. REAL PATH — the actual conversation nodes in order (what really happened)
2. AI BRANCHES — 2-3 alternative paths at the weakest seller moments, showing better responses that lead to higher win rates based on the historical data below

=== HISTORICAL NODE WIN RATES (${wonCount} wins / ${lostCount} losses across ${store.calls.length} past calls) ===
${statTableStr}

IMPORTANT: Use winRate as the primary signal for successProbability on every node you generate.
- Match each node to the closest entry in the table by title (fuzzy match is fine).
- For AI branch nodes, target node titles with the highest win rates (Curious, Pilot Offer, etc.).
- If a node title has no historical match, estimate based on the semantic meaning.

=== UPLOADED CALL TRANSCRIPT ===
${transcriptText}

=== OUTPUT FORMAT (JSON only, no prose) ===
{
  "realPath": [
    {
      "title": "Short node title (≤5 words, match historical titles where possible)",
      "description": "What was said or decided at this moment (1 sentence)",
      "speaker": "seller or buyer",
      "successProbability": 0.0-1.0,
      "transcriptIndices": [0, 1, 2]
    }
  ],
  "branches": [
    {
      "parentRealPathIndex": 2,
      "nodes": [
        {
          "title": "Better response title",
          "description": "What the seller could have said instead",
          "speaker": "seller",
          "successProbability": 0.75
        },
        {
          "title": "Buyer reaction",
          "description": "How the buyer would likely have responded",
          "speaker": "buyer",
          "successProbability": 0.85
        }
      ]
    }
  ]
}

Rules:
- Every transcript segment must be in exactly one realPath node
- successProbability must be anchored to the historical win rates — do not invent numbers
- AI branches must target higher win-rate paths than the real path achieved
- Aim for 4-8 realPath nodes and 2-3 branches with 2-3 nodes each`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env["OPENAI_API_KEY"]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(no body)");
    throw new Error(`[tree-generator] GPT error ${response.status}: ${errText}`);
  }

  const data = await response.json() as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as GptTreeOutput;
  return parsed;
}

// ---------------------------------------------------------------------------
// Tree assembly from GPT output
// ---------------------------------------------------------------------------

function assembleTree(
  treeId: Id,
  callId: Id,
  gptOutput: GptTreeOutput,
  transcript: TranscriptSegment[],
  audioScores: Map<number, AudioScore>,
): {
  tree: Tree;
  traversal: {
    initialNodeId: Id;
    finalNodeId: Id;
    steps: Array<{ transcriptIndex: number; fromNodeId: Id; toNodeId: Id; tMs: number }>;
  };
} {
  const nodes: TreeNode[] = [];
  const realPathIds: Id[] = [];

  // Build real path nodes
  let prevNodeId: Id | null = null;
  for (let i = 0; i < gptOutput.realPath.length; i++) {
    const gn = gptOutput.realPath[i];
    const nodeId = newId("n");
    realPathIds.push(nodeId);

    const nodeSegments = gn.transcriptIndices
      .map((idx) => transcript[idx])
      .filter(Boolean);

    const metrics = metricsForSegments(nodeSegments, audioScores);
    const firstSeg = nodeSegments[0];
    const tMs = firstSeg?.tStartMs ?? i * 5000;

    const node: TreeNode = {
      id: nodeId,
      parentId: prevNodeId,
      childIds: [],
      title: gn.title,
      description: gn.description,
      speaker: gn.speaker,
      tMs,
      successProbability: Math.min(1, Math.max(0, gn.successProbability)),
      expectedValue: Math.round(Math.min(1, Math.max(0, gn.successProbability)) * DEAL_VALUE),
      metrics,
    };

    if (prevNodeId) {
      const parent = nodes.find((n) => n.id === prevNodeId);
      if (parent) parent.childIds.push(nodeId);
    }

    nodes.push(node);
    prevNodeId = nodeId;
  }

  // Build AI branch nodes
  for (const branch of gptOutput.branches ?? []) {
    const parentRealNode = nodes[branch.parentRealPathIndex];
    if (!parentRealNode) continue;

    let branchParentId = parentRealNode.id;
    for (const gn of branch.nodes) {
      const nodeId = newId("n");
      const sp = Math.min(1, Math.max(0, gn.successProbability));

      const node: TreeNode = {
        id: nodeId,
        parentId: branchParentId,
        childIds: [],
        title: gn.title,
        description: gn.description,
        speaker: gn.speaker,
        tMs: parentRealNode.tMs + 1000,
        successProbability: sp,
        expectedValue: Math.round(sp * DEAL_VALUE),
        // AI branch nodes have no real audio — derive metrics from successProbability
        metrics: {
          confidence: Math.round(sp * 100) / 100,
          hesitation: Math.round((1 - sp) * 100) / 100,
          enthusiasm: Math.round(sp * 100) / 100,
        },
      };

      const parent = nodes.find((n) => n.id === branchParentId);
      if (parent) parent.childIds.push(nodeId);

      nodes.push(node);
      branchParentId = nodeId;
    }
  }

  const rootNodeId = realPathIds[0];
  const finalNodeId = realPathIds[realPathIds.length - 1];

  const steps = realPathIds.slice(1).map((toNodeId, i) => ({
    transcriptIndex: gptOutput.realPath[i + 1].transcriptIndices[0] ?? i + 1,
    fromNodeId: realPathIds[i],
    toNodeId,
    tMs: nodes.find((n) => n.id === toNodeId)?.tMs ?? 0,
  }));

  const tree: Tree = { id: treeId, callId, rootNodeId, nodes };
  const traversal = { initialNodeId: rootNodeId, finalNodeId, steps };

  return { tree, traversal };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a complete call decision tree from a diarized transcript.
 *
 * Reads `store._nodeStats` for historical win rates — make sure
 * `refreshStatCache()` has been called at least once before this.
 */
export async function generateCallTree(
  treeId: Id,
  callId: Id,
  transcript: TranscriptSegment[],
  audioScores: Map<number, AudioScore>,
): Promise<{
  tree: Tree;
  traversal: {
    initialNodeId: Id;
    finalNodeId: Id;
    steps: Array<{ transcriptIndex: number; fromNodeId: Id; toNodeId: Id; tMs: number }>;
  };
}> {
  const statCount = store._nodeStats?.length ?? 0;
  console.log(
    `[tree-generator] Using stat cache (${statCount} node titles) for ${transcript.length} segments…`,
  );

  const gptOutput = await callGpt(transcript);

  if (!Array.isArray(gptOutput.realPath) || gptOutput.realPath.length === 0) {
    throw new Error("[tree-generator] GPT returned an empty realPath");
  }

  console.log(
    `[tree-generator] GPT returned ${gptOutput.realPath.length} real-path nodes and ${gptOutput.branches?.length ?? 0} branches`,
  );

  return assembleTree(treeId, callId, gptOutput, transcript, audioScores);
}
