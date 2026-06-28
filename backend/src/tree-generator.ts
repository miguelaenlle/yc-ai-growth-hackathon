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
  NodeStats,
  NodeStatEntry,
  SignalMetrics,
  TranscriptSegment,
  Tree,
  TreeNode,
} from "./types.js";

// Seeded trees all use "n_open" as the canonical root id; parts of the frontend
// (the review-page focus, the summarize animation) assume it. Pin uploaded trees
// to the same root so they render like every other call.
const CANONICAL_ROOT_ID = "n_open";

// The master move graph the seeded calls are built from. Generated trees should map
// the real conversation onto THESE moves — same titles, same speaker per move, same
// terse description voice — so uploaded calls read like seeded ones (and their titles
// join the win-rate table). `{tool}` is filled with the prospect's incumbent.
const CANONICAL_MOVES: { title: string; speaker: "seller" | "buyer"; description: string }[] = [
  { title: "Opening", speaker: "seller", description: "Set the agenda" },
  { title: "Discovery", speaker: "seller", description: "How does your team work today?" },
  { title: "Incumbent", speaker: "buyer", description: "We already use {tool}" },
  { title: "Coexist", speaker: "seller", description: "Runs alongside {tool}" },
  { title: "Find Pain", speaker: "seller", description: "What's painful about {tool}?" },
  { title: "Knock Incumbent", speaker: "seller", description: "Knock {tool} as clunky" },
  { title: "Curious", speaker: "buyer", description: "Where does it win?" },
  { title: "Pushback", speaker: "buyer", description: "We just standardized on {tool}" },
  { title: "Pain Found", speaker: "buyer", description: "Search is weak, threads get lost" },
  { title: "Defensive", speaker: "buyer", description: "Just send me some info" },
  { title: "Show Fit", speaker: "seller", description: "Pitch the fix for their pain" },
  { title: "Pilot Offer", speaker: "seller", description: "Offer a 2-week pilot" },
  { title: "Pilot Won", speaker: "buyer", description: "Let's run the pilot" },
  { title: "Demo Booked", speaker: "buyer", description: "Book me a demo" },
  { title: "Price Ask", speaker: "buyer", description: "What's this run for us?" },
  { title: "Anchor Value", speaker: "seller", description: "Anchor on value per seat" },
  { title: "Discount", speaker: "seller", description: "Lead with a discount" },
  { title: "Proof Ask", speaker: "buyer", description: "Prove it pays off at our size" },
  { title: "Too Pricey", speaker: "buyer", description: "Still too expensive" },
  { title: "Case Closes", speaker: "buyer", description: "That case study sells me" },
  { title: "Anchored Low", speaker: "buyer", description: "Can you go lower?" },
];

/** Catalog string for the prompt: each canonical move with its speaker, win-rate, voice. */
function formatMoveCatalog(): string {
  const stats = store._nodeStats ?? [];
  const wr = (title: string) => {
    const e = stats.find((s) => s.title.toLowerCase() === title.toLowerCase());
    return e ? `${Math.round(e.winRate * 100)}% win` : "—";
  };
  return CANONICAL_MOVES.map(
    (m) => `- "${m.title}" — ${m.speaker.toUpperCase()} turn, ${wr(m.title)}, voiced like: "${m.description}"`,
  ).join("\n");
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Resolve real observed win-stats for a node by matching its title against the
 * persisted population table (`store._nodeStats`). When a node title matches a
 * historical move, the uploaded node inherits that move's real counts + smoothed
 * win-rate — exactly like a seeded node. No match → synthesize light counts from
 * the model's successProbability so the shape is still populated.
 */
function statsForNode(title: string, sp: number): { stats: NodeStats; successProbability: number } {
  const entry = (store._nodeStats ?? []).find((s) => s.title.toLowerCase() === title.toLowerCase());
  if (entry) {
    return {
      stats: { visits: entry.sampleSize, wins: entry.wins, winRate: entry.winRate },
      successProbability: entry.winRate, // align with seeded nodes (sp == smoothed win-rate)
    };
  }
  // No historical match — synthesize plausible counts consistent with sp.
  const visits = 6;
  const wins = Math.round(clamp01(sp) * visits);
  return { stats: { visits, wins, winRate: clamp01(sp) }, successProbability: clamp01(sp) };
}

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

  const moveCatalog = formatMoveCatalog();

  const prompt = `You are a sales call analyst for a B2B SaaS company (the seller is Slack).

Map this uploaded sales call onto our standard sales-call move graph, so it reads exactly
like the calls already in our system.

=== CANONICAL MOVES (use these EXACT titles and the speaker shown for each) ===
${moveCatalog}

A normal call flows: Opening (seller) → Discovery (seller) → the buyer raises their current
tool (Incumbent, buyer) → the seller responds with ONE of: Coexist / Find Pain / Knock
Incumbent (seller) → buyer reacts (Curious / Pain Found / Pushback / Defensive) → it advances
to a Show Fit / Pilot Offer / Price Ask, etc. Pricing branches: Anchor Value vs Discount.

=== YOUR TASK ===
1. REAL PATH — map what ACTUALLY happened onto the canonical moves, in order:
   - ALWAYS start with "Opening" (seller), then "Discovery" (seller).
   - Use a canonical title VERBATIM for each moment and the EXACT speaker listed for that
     move (e.g. "Find Pain" is a SELLER turn, "Incumbent"/"Curious"/"Defensive" are BUYER turns).
     This is critical — never flip a move's speaker.
   - Do NOT repeat a title in the real path. Pick the single best-matching move per moment.
   - 5-7 nodes, alternating seller→buyer→seller…, following a coherent path through the graph.
2. AI BRANCHES — at the seller's key decision moment (usually right after "Incumbent"), add the
   OTHER canonical seller responses they could have played instead, each followed by the buyer's
   likely reaction. 2-3 branches, 2 nodes each (seller move → buyer reaction).

=== STYLE ===
- Descriptions must be TERSE — ≤6 words, in the voice of the catalog examples (e.g. "Set the
  agenda", "What's painful about Teams?"). NO narration like "The seller asks…". Adapt the
  wording to THIS call's specifics (their actual tool, their actual pain) but keep it short.
- successProbability: anchor to the win-rate shown for that move; don't invent numbers.

=== UPLOADED CALL TRANSCRIPT ===
${transcriptText}

=== OUTPUT FORMAT (JSON only, no prose) ===
{
  "realPath": [
    { "title": "Opening", "description": "Set the agenda", "speaker": "seller", "successProbability": 0.61, "transcriptIndices": [0] }
  ],
  "branches": [
    {
      "parentRealPathIndex": 2,
      "nodes": [
        { "title": "Find Pain", "description": "What's painful about {tool}?", "speaker": "seller", "successProbability": 0.94 },
        { "title": "Pain Found", "description": "Search is weak, threads get lost", "speaker": "buyer", "successProbability": 0.94 }
      ]
    }
  ]
}

Rules:
- Every transcript segment must belong to exactly one realPath node.
- Canonical title + its canonical speaker, verbatim; terse descriptions; no repeated titles.
- AI branches show the stronger alternative seller moves at the key fork.`;

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
    // Pin the root to the canonical id the frontend expects; rest get fresh ids.
    const nodeId = i === 0 ? CANONICAL_ROOT_ID : newId("n");
    realPathIds.push(nodeId);

    const nodeSegments = gn.transcriptIndices
      .map((idx) => transcript[idx])
      .filter(Boolean);

    const metrics = metricsForSegments(nodeSegments, audioScores);
    const firstSeg = nodeSegments[0];
    const tMs = firstSeg?.tStartMs ?? i * 5000;

    const { stats, successProbability } = statsForNode(gn.title, gn.successProbability);
    const node: TreeNode = {
      id: nodeId,
      parentId: prevNodeId,
      childIds: [],
      title: gn.title,
      description: gn.description,
      speaker: gn.speaker,
      tMs,
      successProbability,
      expectedValue: Math.round(successProbability * DEAL_VALUE),
      metrics,
      stats,
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
      const { stats, successProbability: sp } = statsForNode(gn.title, gn.successProbability);

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
        stats,
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
