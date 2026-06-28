// build.ts — deterministic seed builder for CallTree.
//
//   npm run seed -- --dry-run     print tree + stats + hero transcript + 2 calls, write nothing
//   npm run seed                  full build → backend/src/data/seed.json + frontend tree.generated.ts
//   npm run seed -- --refresh     bypass the LLM cache and regenerate copy
//
// One source (seed/calltree.seed.ts) → both the backend store and the frontend
// review tree, so they can never drift. Node win-rates/EVs are DERIVED from the
// call outcomes (Beta-smoothed), never hand-set. All LLM calls are gpt-4o-mini,
// JSON mode, low temp, and cached to seed/cache/*.json.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buyerFirstNames,
  buyerLastNames,
  buyerTitles,
  calls,
  company,
  dealValue,
  hero,
  heroBuyer,
  salespeople,
  showcase,
  tree as seedTree,
  type Outcome,
  type SeedTreeNode,
  type Speaker,
} from "./calltree.seed.js";

import type {
  AiFeedback,
  AssistCard,
  Buyer,
  Call,
  Recording,
  SeedStore,
  TranscriptSegment,
  Traversal,
  TraversalStep,
  TreeNode,
} from "../backend/src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const CACHE_DIR = join(__dirname, "cache");
const BACKEND_SEED = join(REPO, "backend", "src", "data", "seed.json");
const FE_GENERATED = join(REPO, "frontend", "src", "data", "tree.generated.ts");

// Load OPENAI_API_KEY from backend/.env without depending on backend's node_modules.
try {
  (process as NodeJS.Process & { loadEnvFile?: (p: string) => void }).loadEnvFile?.(
    join(REPO, "backend", ".env"),
  );
} catch {
  /* no .env — LLM steps fall back to deterministic copy */
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const REFRESH = argv.includes("--refresh");

const STEP_MS = 11000; // wall-clock spacing per tree depth level
const TREE_ID = "tree_slack";
const HERO_CALL_ID = "call_hero";
const HERO_REAL_REC = "rec_real";
const HERO_MOCK_REC = "rec_mock";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const pad2 = (n: number) => String(n).padStart(2, "0");
const ev = (p: number) => Math.round(p * dealValue);

function die(msg: string): never {
  console.error(`\n✗ seed build failed: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Flatten the tree → ordered nodes with ids, parent/child wiring, depth, tMs
// ---------------------------------------------------------------------------

interface FlatNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  speaker: Speaker;
  intent: string;
  depth: number;
  tMs: number;
}

function flattenTree(): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (node: SeedTreeNode, parentId: string | null, depth: number) => {
    const childIds = (node.children ?? []).map((c) => c.key);
    out.push({
      id: node.key,
      parentId,
      childIds,
      speaker: node.speaker,
      intent: node.intent,
      depth,
      tMs: depth * STEP_MS,
    });
    for (const child of node.children ?? []) walk(child, node.key, depth + 1);
  };
  walk(seedTree, null, 0);
  return out;
}

// ---------------------------------------------------------------------------
// 2. Derive stats (visits/wins/winRate) + successProbability from the calls
// ---------------------------------------------------------------------------

interface NodeStat {
  visits: number;
  wins: number;
  winRate: number; // Beta-smoothed (wins+1)/(visits+2)
}

function deriveStats(flat: FlatNode[]) {
  const stats = new Map<string, NodeStat>();
  for (const n of flat) stats.set(n.id, { visits: 0, wins: 0, winRate: 0 });

  for (const arc of calls) {
    const win = arc.outcome === "won";
    for (const nodeId of arc.path) {
      const s = stats.get(nodeId);
      if (!s) die(`archetype ${arc.key} references unknown node ${nodeId}`);
      s.visits += arc.count;
      if (win) s.wins += arc.count;
    }
  }
  for (const s of stats.values()) s.winRate = (s.wins + 1) / (s.visits + 2);

  // Each leaf's own outcome (from the archetype that terminates there).
  const leafOutcome = new Map<string, Outcome>();
  for (const arc of calls) {
    const leaf = arc.path[arc.path.length - 1];
    const prev = leafOutcome.get(leaf);
    if (prev && prev !== arc.outcome) {
      die(`leaf ${leaf} has conflicting outcomes (${prev} vs ${arc.outcome})`);
    }
    leafOutcome.set(leaf, arc.outcome);
  }

  return { stats, leafOutcome };
}

/**
 * Node success probability. Internal nodes read straight off the Beta-smoothed
 * win-rate. Leaves are pinned to reflect their own outcome so the call's derived
 * outcome (won ≥0.8 / lost ≤0.1 / else open) always resolves correctly.
 */
function successProbability(
  node: FlatNode,
  stat: NodeStat,
  leafOutcome: Outcome | undefined,
): number {
  const isLeaf = node.childIds.length === 0;
  if (!isLeaf) return round4(stat.winRate);
  switch (leafOutcome) {
    case "won":
      return round4(Math.max(stat.winRate, 0.85));
    case "lost":
      return round4(Math.min(stat.winRate, 0.08));
    default: // open — keep it clearly between the won/lost thresholds, with margin
      return round4(clamp(stat.winRate, 0.18, 0.78));
  }
}

function deriveMetrics(p: number) {
  return {
    confidence: round2(0.35 + 0.5 * p),
    hesitation: round2(clamp(0.85 - 0.7 * p, 0.08, 0.92)),
    enthusiasm: round2(0.3 + 0.6 * p),
  };
}

// ---------------------------------------------------------------------------
// 3. LLM copy (gpt-4o-mini, JSON mode, cached)
// ---------------------------------------------------------------------------

async function cachedLLM<T>(
  name: string,
  build: () => Promise<T>,
  fallback: () => T,
): Promise<T> {
  const file = join(CACHE_DIR, `${name}.json`);
  if (!REFRESH) {
    try {
      const raw = await fs.readFile(file, "utf-8");
      console.log(`  [cache hit] ${name}.json`);
      return JSON.parse(raw) as T;
    } catch {
      /* miss → generate */
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn(`  [no OPENAI_API_KEY] using deterministic fallback for ${name}`);
    return fallback();
  }

  let result: T;
  try {
    result = await build();
  } catch (e) {
    console.warn(`  [llm failed: ${e instanceof Error ? e.message : e}] fallback for ${name}`);
    return fallback();
  }
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(result, null, 2));
  console.log(`  [cache write] ${name}.json`);
  return result;
}

async function chatJSON(systemPrompt: string): Promise<any> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: systemPrompt }],
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}

interface NodeCopy {
  title: string;
  description: string;
}

async function buildNodeCopy(flat: FlatNode[]): Promise<Record<string, NodeCopy>> {
  const nodeList = flat
    .map((n) => `- ${n.id} | ${n.speaker.toUpperCase()} | ${n.intent}`)
    .join("\n");

  const prompt = `You are writing SHORT copy for nodes in a sales-call decision tree, shown on small cards. The deal is selling Slack (team messaging — channels, threads, search, integrations) into a 250-seat company on Microsoft Teams. Buyer is a VP-level prospect; seller is a Slack account executive.

For each node below, write:
- "title": a 2-4 word label (e.g. "Teams incumbent", "Coexist reframe", "Pilot offer").
- "description": a TERSE fragment, MAX 9 WORDS — NOT a full sentence, no trailing period. A snappy gist of the beat. Buyer beats can be a short quoted phrase (e.g. "We're standardized on Teams"); seller beats a brief move (e.g. "Reframe: run alongside Teams").

Keep it tight enough to fit two short lines on a card. Nodes:
${nodeList}

Return JSON: { "nodes": [ { "key": "<exact node id>", "title": "...", "description": "..." }, ... ] } with exactly one entry per node above, keys matching exactly.`;

  const parsed = await chatJSON(prompt);
  const map: Record<string, NodeCopy> = {};
  for (const item of parsed.nodes ?? []) {
    if (item?.key) map[item.key] = { title: String(item.title ?? ""), description: String(item.description ?? "") };
  }
  return map;
}

function fallbackNodeCopy(flat: FlatNode[]): Record<string, NodeCopy> {
  const map: Record<string, NodeCopy> = {};
  for (const n of flat) {
    const title = n.id.replace(/^n_/, "").replace(/_/g, " ");
    map[n.id] = { title: title.charAt(0).toUpperCase() + title.slice(1), description: n.intent };
  }
  return map;
}

// ---------------------------------------------------------------------------
// 4. Build the canonical tree nodes
// ---------------------------------------------------------------------------

function buildTreeNodes(
  flat: FlatNode[],
  copy: Record<string, NodeCopy>,
  stats: Map<string, NodeStat>,
  leafOutcome: Map<string, Outcome>,
): TreeNode[] {
  return flat.map((n) => {
    const stat = stats.get(n.id)!;
    const p = successProbability(n, stat, leafOutcome.get(n.id));
    const c = copy[n.id] ?? { title: n.id, description: n.intent };
    return {
      id: n.id,
      parentId: n.parentId,
      childIds: n.childIds,
      title: c.title,
      description: c.description,
      speaker: n.speaker,
      tMs: n.tMs,
      successProbability: p,
      expectedValue: ev(p),
      metrics: deriveMetrics(p),
      stats: { visits: stat.visits, wins: stat.wins, winRate: round4(stat.winRate) },
    };
  });
}

// ---------------------------------------------------------------------------
// 5. Hero transcript + feedback + assist (LLM, cached)
// ---------------------------------------------------------------------------

async function buildHeroTranscript(heroPath: TreeNode[]): Promise<{ speaker: Speaker; text: string }[]> {
  const beats = heroPath
    .map((n) => `- ${n.speaker.toUpperCase()} | "${n.title}" | ${n.description}`)
    .join("\n");
  const prompt = `Write a realistic, natural transcript of a B2B sales call where a Slack account executive (seller) pitches Sarah Chen, VP of Operations (buyer) at a 250-seat company on Microsoft Teams. This is the call where the rep makes a MISTAKE — they disparage Teams instead of building value — and loses the deal.

Follow these beats in order (the speaker alternates naturally; you may add a brief back-and-forth around a beat, but keep the overall arc):
${beats}

Return JSON: { "segments": [ { "speaker": "seller"|"buyer", "text": "<one spoken line>" }, ... ] }. 10-16 segments. Conversational, concrete, no stage directions. End on the buyer disengaging ("just send me some info").`;
  const parsed = await chatJSON(prompt);
  const segs = (parsed.segments ?? []) as { speaker: string; text: string }[];
  return segs
    .filter((s) => s && (s.speaker === "seller" || s.speaker === "buyer") && s.text)
    .map((s) => ({ speaker: s.speaker as Speaker, text: String(s.text) }));
}

function fallbackHeroTranscript(heroPath: TreeNode[]): { speaker: Speaker; text: string }[] {
  return heroPath.map((n) => ({ speaker: n.speaker, text: n.description }));
}

async function buildHeroFeedback(heroPath: TreeNode[]): Promise<AiFeedback> {
  const ctx = heroPath
    .map((n) => `${n.id} | ${n.speaker.toUpperCase()} | "${n.title}" | ${n.description} | EV $${n.expectedValue}`)
    .join("\n");
  const prompt = `You are a sales coach reviewing a LOST Slack-vs-Teams call. The rep disparaged Microsoft Teams ("n_knock") right after the buyer raised it as the incumbent ("n_incumbent"), which made the buyer defensive and ended the deal.

Call path:
${ctx}

Return JSON matching this shape exactly:
{
  "summary": "<2-3 sentence honest debrief of what went wrong>",
  "strengths": ["<short>", "<short>"],
  "weaknesses": ["<short>", "<short>"],
  "practiceTargets": [
    { "nodeId": "n_knock", "reason": "<why this hurt>", "drill": "<what to practice instead>", "metric": "confidence"|"hesitation"|"enthusiasm", "score": <0..1> },
    { "nodeId": "n_incumbent", "reason": "<why this was the fork>", "drill": "<better move>", "metric": "confidence"|"hesitation"|"enthusiasm", "score": <0..1> }
  ]
}
practiceTargets MUST include n_knock and n_incumbent.`;
  const parsed = (await chatJSON(prompt)) as AiFeedback;
  // Guarantee the two required targets are present.
  const targets = Array.isArray(parsed.practiceTargets) ? parsed.practiceTargets : [];
  for (const required of ["n_knock", "n_incumbent"]) {
    if (!targets.some((t) => t.nodeId === required)) {
      targets.push({
        nodeId: required,
        reason: required === "n_knock" ? "Disparaging Teams made the buyer defensive." : "The incumbent objection was the real fork in the call.",
        drill: required === "n_knock" ? "Acknowledge Teams, then build value for Slack." : "Reframe to coexistence or surface a real pain.",
        metric: "confidence",
        score: required === "n_knock" ? 0.72 : 0.41,
      });
    }
  }
  return { ...parsed, practiceTargets: targets };
}

function fallbackHeroFeedback(): AiFeedback {
  return {
    summary:
      "You opened well and got Sarah talking, but the moment she raised Teams you knocked it instead of building value. That made her defensive and the deal stalled.",
    strengths: ["Warm, low-friction open", "Got the buyer engaged quickly"],
    weaknesses: ["Disparaged the incumbent instead of reframing", "Lost the room after the Teams objection"],
    practiceTargets: [
      { nodeId: "n_knock", reason: "Knocking Teams made Sarah defensive.", drill: "Acknowledge Teams, then pivot to where Slack wins.", metric: "confidence", score: 0.72 },
      { nodeId: "n_incumbent", reason: "The incumbent objection was the real fork.", drill: "Reframe to coexistence or surface a concrete pain.", metric: "hesitation", score: 0.41 },
    ],
  };
}

async function buildHeroAssist(heroPath: TreeNode[]): Promise<AssistCard> {
  const incumbent = heroPath.find((n) => n.id === "n_incumbent");
  const trigger = incumbent?.description ?? "We already use Microsoft Teams.";
  const prompt = `A buyer on a Slack sales call just said: "${trigger}". Write a concise real-time coaching card for the seller — 2-3 sentences telling them how to handle the Teams incumbent objection (coexistence, where Slack wins on search/threads/integrations). Return JSON: { "triggerText": "${trigger.replace(/"/g, "'")}", "response": "<coaching>", "searchedWeb": false }.`;
  const parsed = (await chatJSON(prompt)) as AssistCard;
  return {
    triggerText: parsed.triggerText ?? trigger,
    response: parsed.response ?? "",
    searchedWeb: Boolean(parsed.searchedWeb),
  };
}

function fallbackHeroAssist(heroPath: TreeNode[]): AssistCard {
  const incumbent = heroPath.find((n) => n.id === "n_incumbent");
  return {
    triggerText: incumbent?.description ?? "We already use Microsoft Teams.",
    response:
      "Don't knock Teams — agree it's fine for meetings. Position Slack as the layer on top: faster search, threads that don't get lost, and deep app integrations. Offer a one-team pilot so it's low risk.",
    searchedWeb: false,
  };
}

// ---------------------------------------------------------------------------
// 6. Build calls + recordings
// ---------------------------------------------------------------------------

// Fixed base instant so startedAt values are deterministic across runs.
const BASE_MS = Date.parse("2026-06-27T17:00:00-07:00");


function codeBuiltTranscript(path: TreeNode[]): TranscriptSegment[] {
  return path.map((n, i) => ({
    index: i,
    speaker: n.speaker,
    text: n.description,
    tStartMs: n.tMs,
    tEndMs: n.tMs + STEP_MS,
  }));
}

function heroTranscript(lines: { speaker: Speaker; text: string }[], lengthMs: number): TranscriptSegment[] {
  const per = Math.max(1, Math.floor(lengthMs / Math.max(1, lines.length)));
  return lines.map((l, i) => ({
    index: i,
    speaker: l.speaker,
    text: l.text,
    tStartMs: i * per,
    tEndMs: (i + 1) * per,
  }));
}

/** Traversal whose steps walk the node path; each step points at the segment that triggered it. */
function buildTraversal(
  path: TreeNode[],
  segmentIndexForNode: (nodeId: string, pathIndex: number) => number,
): Traversal {
  const steps: TraversalStep[] = [];
  for (let i = 1; i < path.length; i++) {
    steps.push({
      transcriptIndex: segmentIndexForNode(path[i].id, i),
      fromNodeId: path[i - 1].id,
      toNodeId: path[i].id,
      tMs: path[i].tMs,
    });
  }
  return {
    initialNodeId: path[0].id,
    finalNodeId: path[path.length - 1].id,
    steps,
  };
}

interface BuiltPopulation {
  calls: Call[];
  recordings: Record<string, Recording>;
  samples: { callId: string; archetype: string; outcome: Outcome; recording: Recording }[];
}

/** A hand/LLM-authored "feature" call (hero, showcase): richer than the population default. */
interface SpecialCall {
  callId: string;
  realRecId: string;
  mockRecId: string;
  mockStartNode: string;
  buyer: Buyer;
  sellerId: string;
  transcript: TranscriptSegment[];
  lengthMs: number;
  aiNotes: AssistCard | null;
  aiFeedback: AiFeedback | null;
}

/**
 * Up to 60 unique prospect buyers. With 12 firsts and 5 lasts (coprime), the pair
 * (i % 12, i % 5) is unique for i in 0..59, so first[i%12] + last[i%5] yields 60
 * distinct names AND varies the surname on every card (no "Lopez" clustering).
 */
function buildBuyerPool(count: number): Buyer[] {
  const out: Buyer[] = [];
  for (let i = 0; i < count; i++) {
    const first = buyerFirstNames[i % buyerFirstNames.length];
    const last = buyerLastNames[i % buyerLastNames.length];
    out.push({ id: `buy_${pad2(i + 1)}`, name: `${first} ${last}`, title: buyerTitles[i % buyerTitles.length] });
  }
  return out;
}

function buildPopulation(
  nodeById: Map<string, TreeNode>,
  buyerPool: Buyer[],
  specials: Map<string, SpecialCall>,
): BuiltPopulation {
  const callRecords: Call[] = [];
  const recordings: Record<string, Recording> = {};
  const samples: BuiltPopulation["samples"] = [];
  let globalIndex = 0;
  let poolIdx = 0;

  for (const arc of calls) {
    const path = arc.path.map((id) => {
      const n = nodeById.get(id);
      if (!n) die(`archetype ${arc.key} path references unknown node ${id}`);
      return n;
    });

    for (let i = 0; i < arc.count; i++) {
      const special = specials.get(`${arc.key}#${i}`);
      const callId = special?.callId ?? `call_${arc.key.toLowerCase()}_${pad2(i + 1)}`;
      const realRecId = special?.realRecId ?? `rec_${arc.key.toLowerCase()}_${pad2(i + 1)}`;

      // Special calls carry a pinned buyer + rep; everyone else gets a unique
      // pool buyer and a rep round-robined across all 5. startedAt is assigned
      // later (interleaved) so the list mixes outcomes instead of grouping them.
      const buyer = special?.buyer ?? buyerPool[poolIdx++];
      const sellerId = special?.sellerId ?? salespeople[globalIndex % salespeople.length].id;

      const transcript = special?.transcript ?? codeBuiltTranscript(path);
      const lengthMs = special?.lengthMs ?? path.length * STEP_MS;

      // Map each non-root path node to the transcript segment that lands on it.
      // Special transcripts are free-form, so attribute steps to evenly-spaced
      // segments; population calls are 1 segment per node.
      const segIndexForNode = special
        ? (_id: string, pathIdx: number) =>
            Math.min(transcript.length - 1, Math.round((pathIdx / (path.length - 1 || 1)) * (transcript.length - 1)))
        : (_id: string, pathIdx: number) => pathIdx;

      const real: Recording = {
        id: realRecId,
        callId,
        treeId: TREE_ID,
        isReal: true,
        isActive: false,
        startNodeId: path[0].id,
        stopNodeId: null,
        audioPath: `/data/audio/${realRecId}.webm`,
        lengthMs,
        transcript,
        traversal: buildTraversal(path, segIndexForNode),
        aiNotes: special?.aiNotes ?? null,
        aiFeedback: special?.aiFeedback ?? null,
      };
      recordings[realRecId] = real;

      const recordingIds = [realRecId];

      if (special) {
        // A mock recording so SimulateCallPage (recordings.find(r => !r.isReal)) resolves the tree.
        const mock: Recording = {
          id: special.mockRecId,
          callId,
          treeId: TREE_ID,
          isReal: false,
          isActive: false,
          startNodeId: special.mockStartNode,
          stopNodeId: null,
          audioPath: "",
          lengthMs: 0,
          transcript: [],
          traversal: { initialNodeId: special.mockStartNode, finalNodeId: special.mockStartNode, steps: [] },
          aiNotes: null,
          aiFeedback: null,
        };
        recordings[special.mockRecId] = mock;
        recordingIds.push(special.mockRecId);
      }

      callRecords.push({
        id: callId,
        companyId: company.id,
        salespersonId: sellerId,
        buyerId: buyer.id,
        startedAt: "", // assigned (interleaved) after the full population is built
        treeId: TREE_ID,
        recordingIds,
      });

      // Keep two illustrative samples for the dry-run print (a win and the open stall).
      if ((arc.key === "A" && i === 0) || (arc.key === "G" && i === 0)) {
        samples.push({ callId, archetype: arc.key, outcome: arc.outcome, recording: real });
      }

      globalIndex++;
    }
  }

  return { calls: callRecords, recordings, samples };
}

/**
 * Assign startedAt so the list reads like a real history: the showcase is newest
 * (tops the list), the hero second, and the rest round-robined across archetypes
 * so outcomes alternate (win, loss, win, stall, …) instead of clustering.
 */
function assignDates(callRecords: Call[]) {
  const pinned = [showcase.callId, HERO_CALL_ID];
  const rest = callRecords.filter((c) => !pinned.includes(c.id));

  // Bucket by archetype letter (call_a_01 → "a"), then pull one from each bucket
  // per round so adjacent calls come from different archetypes.
  const buckets = new Map<string, Call[]>();
  for (const c of rest) {
    const letter = c.id.split("_")[1] ?? "z";
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter)!.push(c);
  }
  const lists = [...buckets.values()];
  const interleaved: Call[] = [];
  for (let round = 0; interleaved.length < rest.length; round++) {
    for (const list of lists) if (round < list.length) interleaved.push(list[round]);
  }

  const ordered = [
    callRecords.find((c) => c.id === showcase.callId)!,
    callRecords.find((c) => c.id === HERO_CALL_ID)!,
    ...interleaved,
  ];
  ordered.forEach((c, i) => {
    c.startedAt = new Date(BASE_MS - i * 8 * 3600_000).toISOString();
  });
}

// ---------------------------------------------------------------------------
// 7. Validation
// ---------------------------------------------------------------------------

function validate(nodes: TreeNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) die("duplicate node ids");

  const roots = nodes.filter((n) => n.parentId === null);
  if (roots.length !== 1) die(`expected exactly one root, found ${roots.length}`);
  if (roots[0].id !== seedTree.key) die(`root must be ${seedTree.key}`);

  for (const n of nodes) {
    if (n.successProbability < 0 || n.successProbability > 1) {
      die(`node ${n.id} has out-of-range successProbability ${n.successProbability}`);
    }
    for (const c of n.childIds) {
      const child = byId.get(c);
      if (!child) die(`node ${n.id} childId ${c} does not resolve`);
      if (child.parentId !== n.id) die(`child ${c} parentId mismatch (${child.parentId} ≠ ${n.id})`);
    }
    if (n.parentId !== null) {
      const parent = byId.get(n.parentId);
      if (!parent) die(`node ${n.id} parentId ${n.parentId} does not resolve`);
      if (!parent.childIds.includes(n.id)) die(`node ${n.id} not listed in parent ${n.parentId}.childIds`);
    }
  }

  // Every archetype path must be a contiguous root→leaf walk.
  for (const arc of calls) {
    if (arc.path[0] !== seedTree.key) die(`archetype ${arc.key} does not start at root`);
    for (let i = 1; i < arc.path.length; i++) {
      const parent = byId.get(arc.path[i - 1])!;
      if (!parent.childIds.includes(arc.path[i])) {
        die(`archetype ${arc.key}: ${arc.path[i]} is not a child of ${arc.path[i - 1]}`);
      }
    }
    const leaf = byId.get(arc.path[arc.path.length - 1])!;
    if (leaf.childIds.length !== 0) die(`archetype ${arc.key} does not end on a leaf (${leaf.id})`);
  }
}

// ---------------------------------------------------------------------------
// 8. Emit frontend tree.generated.ts
// ---------------------------------------------------------------------------

interface RawNodeOut {
  id: string;
  kind: "real" | "ai";
  title: string;
  description: string;
  success?: number;
  onPath?: boolean;
  children?: RawNodeOut[];
}

function buildRawTree(nodes: TreeNode[], heroPathIds: Set<string>): RawNodeOut {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const build = (id: string): RawNodeOut => {
    const n = byId.get(id)!;
    const real = heroPathIds.has(id);
    const node: RawNodeOut = {
      id: n.id,
      kind: real ? "real" : "ai",
      title: n.title,
      description: n.description,
    };
    if (real) node.onPath = true;
    else node.success = round2(n.successProbability);
    const children = n.childIds.map(build);
    if (children.length) node.children = children;
    return node;
  };
  return build(seedTree.key);
}

function emitFrontend(nodes: TreeNode[], heroPathIds: Set<string>): string {
  const raw = buildRawTree(nodes, heroPathIds);
  const actor: Record<string, Speaker> = {};
  for (const n of nodes) actor[n.id] = n.speaker;

  return `// AUTO-GENERATED by seed/build.ts — DO NOT EDIT BY HAND.
// Run \`npm run seed\` (from backend/) to regenerate. Source: seed/calltree.seed.ts.
// Node ids match the backend seed exactly, so every node is Simulatable/Watchable.
import type { RawNode, Actor } from "../components/tree/treeData";

export const GEN_TREE: RawNode = ${JSON.stringify(raw, null, 2)};

export const GEN_ACTOR: Record<string, Actor> = ${JSON.stringify(actor, null, 2)};
`;
}

// ---------------------------------------------------------------------------
// 9. Dry-run printing
// ---------------------------------------------------------------------------

function printStats(nodes: TreeNode[]) {
  console.log("\n=== Canonical tree (tree_slack) — derived stats ===");
  console.log("id".padEnd(15) + "spk".padEnd(7) + "vis".padStart(4) + "win".padStart(5) + "  winRate" + "  p".padStart(7) + "  EV");
  for (const n of nodes) {
    const s = n.stats!;
    console.log(
      n.id.padEnd(15) +
        n.speaker.slice(0, 4).padEnd(7) +
        String(s.visits).padStart(4) +
        String(s.wins).padStart(5) +
        "   " + s.winRate.toFixed(3) +
        "  " + n.successProbability.toFixed(3) +
        "  $" + n.expectedValue.toLocaleString(),
    );
  }
  const root = nodes.find((n) => n.parentId === null)!;
  const bestEV = Math.max(...nodes.map((n) => n.expectedValue));
  console.log(`\noverall win-rate (root) = ${(root.stats!.winRate * 100).toFixed(1)}%   bestEV = $${bestEV.toLocaleString()}`);
  const pct = (id: string) => ((nodes.find((n) => n.id === id)!.stats!.winRate) * 100).toFixed(0) + "%";
  console.log(`incumbent=${pct("n_incumbent")} coexist=${pct("n_coexist")} knock=${pct("n_knock")} price=${pct("n_price")} value=${pct("n_value")}`);
}

function printTranscript(label: string, rec: Recording) {
  console.log(`\n=== ${label} (${rec.id}, ${rec.transcript.length} segments, ${rec.lengthMs}ms) ===`);
  console.log(`  path: ${[rec.traversal.initialNodeId, ...rec.traversal.steps.map((s) => s.toNodeId)].join(" → ")}`);
  for (const s of rec.transcript) {
    console.log(`  [${s.speaker.toUpperCase().padEnd(6)}] ${s.text}`);
  }
  if (rec.aiFeedback) console.log(`  practiceTargets: ${rec.aiFeedback.practiceTargets.map((t) => t.nodeId).join(", ") || "(none)"}`);
  if (rec.aiNotes) console.log(`  assist trigger: "${rec.aiNotes.triggerText}"`);
}

function printSamples(samples: BuiltPopulation["samples"], nodeById: Map<string, TreeNode>) {
  console.log("\n=== 2 sample population calls ===");
  for (const s of samples) {
    const finalP = nodeById.get(s.recording.traversal.finalNodeId)!.successProbability;
    console.log(`  ${s.callId} (archetype ${s.archetype}, outcome=${s.outcome}, finalP=${finalP.toFixed(2)})`);
    console.log(`    path: ${[s.recording.traversal.initialNodeId, ...s.recording.traversal.steps.map((st) => st.toNodeId)].join(" → ")}`);
    console.log(`    transcript[0]: [${s.recording.transcript[0]?.speaker}] ${s.recording.transcript[0]?.text}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nCallTree seed build — ${DRY_RUN ? "DRY RUN (no files written)" : "FULL BUILD"}${REFRESH ? " (refresh: bypassing LLM cache)" : ""}`);

  const flat = flattenTree();
  console.log(`\nFlattened ${flat.length} nodes.`);
  const { stats, leafOutcome } = deriveStats(flat);

  console.log("\nGenerating node copy…");
  const copy = await cachedLLM("nodes", () => buildNodeCopy(flat), () => fallbackNodeCopy(flat));

  const nodes = buildTreeNodes(flat, copy, stats, leafOutcome);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  validate(nodes);
  console.log("Validation passed.");

  // Hero extras (LLM — the knock-loss "moment it slipped" call).
  const heroArc = calls.find((c) => c.key === hero)!;
  const heroPath = heroArc.path.map((id) => nodeById.get(id)!);

  console.log("\nGenerating hero transcript / feedback / assist…");
  const heroLines = await cachedLLM("hero_transcript", () => buildHeroTranscript(heroPath), () => fallbackHeroTranscript(heroPath));
  const heroFeedback = await cachedLLM("hero_feedback", () => buildHeroFeedback(heroPath), () => fallbackHeroFeedback());
  const heroAssist = await cachedLLM("hero_assist", () => buildHeroAssist(heroPath), () => fallbackHeroAssist(heroPath));

  const heroLen = Math.max(heroLines.length, heroPath.length) * STEP_MS;
  const heroTx = heroTranscript(heroLines, heroLen);

  // Showcase extras (hand-authored — the best "Summarize Call" demo: the full
  // winning line). This path is also the frontend's recorded "real" spine.
  const showcaseArc = calls.find((c) => c.key === showcase.archetype)!;
  const showcasePath = showcaseArc.path.map((id) => nodeById.get(id)!);
  const realSpineIds = new Set(showcaseArc.path);
  const showcaseLen = Math.max(showcase.transcript.length, showcasePath.length) * STEP_MS;
  const showcaseTx = heroTranscript(showcase.transcript, showcaseLen);

  // Two pinned buyers (hero + showcase); every other call draws from the pool.
  const totalCalls = calls.reduce((a, c) => a + c.count, 0);
  const buyerPool = buildBuyerPool(totalCalls - 2);
  const allBuyers: Buyer[] = [heroBuyer, showcase.buyer, ...buyerPool];

  const specials = new Map<string, SpecialCall>([
    [`${hero}#0`, {
      callId: HERO_CALL_ID, realRecId: HERO_REAL_REC, mockRecId: HERO_MOCK_REC,
      mockStartNode: "n_incumbent", buyer: heroBuyer, sellerId: salespeople[0].id,
      transcript: heroTx, lengthMs: heroLen, aiNotes: heroAssist, aiFeedback: heroFeedback,
    }],
    [`${showcase.archetype}#0`, {
      callId: showcase.callId, realRecId: "rec_showcase", mockRecId: "rec_showcase_mock",
      mockStartNode: "n_incumbent", buyer: showcase.buyer, sellerId: showcase.salespersonId,
      transcript: showcaseTx, lengthMs: showcaseLen, aiNotes: null, aiFeedback: showcase.feedback,
    }],
  ]);

  const population = buildPopulation(nodeById, buyerPool, specials);
  assignDates(population.calls);

  const heroReal = population.recordings[HERO_REAL_REC];
  const showcaseReal = population.recordings["rec_showcase"];

  const treeObj = { id: TREE_ID, callId: HERO_CALL_ID, rootNodeId: seedTree.key, nodes };

  const seedStore: SeedStore = {
    _meta: {
      note: `Generated by seed/build.ts from seed/calltree.seed.ts. ${company.name} is a $${dealValue.toLocaleString()} (250-seat) deal; expectedValue = round(successProbability * ${dealValue}). Node win-rates are Beta-smoothed from ${calls.reduce((a, c) => a + c.count, 0)} call outcomes.`,
      dealValue,
    },
    companies: [
      { id: company.id, name: company.name, buyers: allBuyers },
    ],
    salespeople,
    calls: population.calls,
    trees: { [TREE_ID]: treeObj },
    recordings: population.recordings,
  };

  // Reports.
  printStats(nodes);
  printTranscript("SHOWCASE transcript (Summarize demo, win)", showcaseReal);
  printTranscript("Hero transcript (loss)", heroReal);
  printSamples(population.samples, nodeById);
  console.log(`\nPopulation: ${population.calls.length} calls, ${Object.keys(population.recordings).length} recordings.`);
  console.log(`Newest 3 calls (top of list): ${[...population.calls].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 3).map((c) => c.id).join(", ")}`);

  if (DRY_RUN) {
    console.log("\n— DRY RUN complete. No files written. Review the above, then run `npm run seed` to emit. —\n");
    return;
  }

  await fs.mkdir(dirname(BACKEND_SEED), { recursive: true });
  await fs.writeFile(BACKEND_SEED, JSON.stringify(seedStore, null, 2));
  console.log(`\n✓ wrote ${BACKEND_SEED}`);

  await fs.mkdir(dirname(FE_GENERATED), { recursive: true });
  await fs.writeFile(FE_GENERATED, emitFrontend(nodes, realSpineIds));
  console.log(`✓ wrote ${FE_GENERATED}`);
  console.log("\n✓ seed build complete.\n");
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
