// build.ts — deterministic seed builder for CallTree.
//
//   npm run seed -- --dry-run     print tree + stats + hero transcript + 2 calls, write nothing
//   npm run seed                  full build → backend/src/data/seed.json + frontend tree.generated.ts
//   npm run seed -- --refresh     bypass the LLM cache and regenerate the hero transcript copy
//
// One source (seed/calltree.seed.ts) → both the backend store and the frontend
// review tree, so they can never drift. Per-move win-rates/EVs are DERIVED from the
// call outcomes (aggregated per move across the whole population, Beta-smoothed),
// never hand-set. Each call gets its OWN distinct tree (a per-prospect, pruned view
// of the master graph). The only LLM use is the cached hero transcript/feedback;
// everything else is deterministic synthetic data and runs with no OPENAI_API_KEY.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PER_SEAT,
  FEATURED_SALESPERSON_ID,
  HERO_PROSPECT_ID,
  calls,
  dealValue,
  hero,
  heroBuyer,
  personaByArchetype,
  prospects,
  salespeople,
  sellerOrg,
  showcase,
  tree as seedTree,
  type Archetype,
  type Outcome,
  type Prospect,
  type SeedTreeNode,
  type Speaker,
} from "./calltree.seed.js";

import type {
  AiFeedback,
  AssistCard,
  Buyer,
  Call,
  Company,
  Recording,
  SeedStore,
  TranscriptSegment,
  Traversal,
  TraversalStep,
  Tree,
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
const TREE_ID = "tree_slack"; // the full master tree, used by the showcase + hero + GEN_TREE
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
const pad3 = (n: number) => String(n).padStart(3, "0");

const prospectById = new Map(prospects.map((p) => [p.id, p]));
const dealValueOf = (p: Prospect): number => p.seats * PER_SEAT;

/** Deterministic 32-bit hash of a string → used for stable per-call jitter. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Substitute prospect context into a node copy template. */
function render(tpl: string, prospect: Prospect): string {
  return tpl
    .replace(/\{incumbent\}/g, prospect.incumbent)
    .replace(/\{seats\}/g, String(prospect.seats))
    .replace(/\{company\}/g, prospect.name);
}

function die(msg: string): never {
  console.error(`\n✗ seed build failed: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Flatten the master tree → ordered nodes with ids, parent/child wiring, depth
// ---------------------------------------------------------------------------

interface FlatNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  speaker: Speaker;
  title: string;
  descTpl: string;
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
      title: node.title,
      descTpl: node.descTpl,
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
// 2. Derive per-move stats (visits/wins/winRate) + successProbability
// ---------------------------------------------------------------------------

interface NodeStat {
  visits: number;
  wins: number;
  winRate: number; // Beta-smoothed (wins+1)/(visits+2)
}

function deriveStats(flat: FlatNode[]) {
  const stats = new Map<string, NodeStat>();
  for (const n of flat) stats.set(n.id, { visits: 0, wins: 0, winRate: 0 });

  // Aggregate per MOVE (node id) across the whole call population.
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
 * per-move win-rate. Leaves are pinned to reflect their own outcome so the call's
 * derived outcome (won ≥0.8 / lost ≤0.1 / else open) always resolves correctly.
 */
function successProbability(
  isLeaf: boolean,
  stat: NodeStat,
  leafOutcome: Outcome | undefined,
): number {
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

/** Small deterministic per-call jitter so meters aren't identical across calls. */
function jitterMetrics(base: { confidence: number; hesitation: number; enthusiasm: number }, seed: string) {
  const off = (salt: string) => (((hashStr(seed + salt) % 9) - 4) / 100); // -0.04 .. +0.04
  return {
    confidence: round2(clamp(base.confidence + off("c"), 0.05, 0.95)),
    hesitation: round2(clamp(base.hesitation + off("h"), 0.05, 0.95)),
    enthusiasm: round2(clamp(base.enthusiasm + off("e"), 0.05, 0.95)),
  };
}

// ---------------------------------------------------------------------------
// 3. LLM (hero transcript/feedback/assist only — cached; deterministic fallbacks)
// ---------------------------------------------------------------------------

async function cachedLLM<T>(name: string, build: () => Promise<T>, fallback: () => T): Promise<T> {
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

// ---------------------------------------------------------------------------
// 4. Build TreeNodes (a full tree for a prospect, or a pruned per-call tree)
// ---------------------------------------------------------------------------

const flat = flattenTree();
const flatById = new Map(flat.map((n) => [n.id, n]));

/** Build a single TreeNode from a flat node, rendered for `prospect`. */
function makeNode(
  f: FlatNode,
  childIds: string[],
  prospect: Prospect,
  stats: Map<string, NodeStat>,
  leafOutcome: Map<string, Outcome>,
  jitterSeed: string | null,
): TreeNode {
  const stat = stats.get(f.id)!;
  const p = successProbability(f.childIds.length === 0, stat, leafOutcome.get(f.id));
  const baseMetrics = deriveMetrics(p);
  return {
    id: f.id,
    parentId: f.parentId,
    childIds,
    title: f.title,
    description: render(f.descTpl, prospect),
    speaker: f.speaker,
    tMs: f.tMs,
    successProbability: p,
    expectedValue: Math.round(p * dealValueOf(prospect)),
    metrics: jitterSeed ? jitterMetrics(baseMetrics, jitterSeed + f.id) : baseMetrics,
    stats: { visits: stat.visits, wins: stat.wins, winRate: round4(stat.winRate) },
  };
}

/** The full master tree, rendered for one prospect (used by tree_slack + GEN_TREE). */
function buildFullTree(prospect: Prospect, stats: Map<string, NodeStat>, leafOutcome: Map<string, Outcome>): TreeNode[] {
  return flat.map((f) => makeNode(f, f.childIds, prospect, stats, leafOutcome, null));
}

/**
 * A distinct per-call tree: the master graph pruned to the deal type this call is
 * about (incumbent fork OR price fork), rendered for the call's prospect, with a
 * small per-call metric jitter. Probabilities stay the GLOBAL per-move win-rates,
 * so the same move reads the same win-rate everywhere — grounded, not invented.
 */
function buildCallTree(
  callId: string,
  arc: Archetype,
  prospect: Prospect,
  stats: Map<string, NodeStat>,
  leafOutcome: Map<string, Outcome>,
): Tree {
  const top = arc.incumbentShape ? "n_incumbent" : "n_price";
  // Keep: root, discovery, and the full subtree under the on-path fork.
  const keep = new Set<string>(["n_open", "n_disc"]);
  const stack = [top];
  while (stack.length) {
    const id = stack.pop()!;
    keep.add(id);
    for (const c of flatById.get(id)!.childIds) stack.push(c);
  }

  const nodes = [...keep].map((id) => {
    const f = flatById.get(id)!;
    const childIds = id === "n_disc" ? [top] : f.childIds.filter((c) => keep.has(c));
    return makeNode(f, childIds, prospect, stats, leafOutcome, callId);
  });

  return { id: `tree_${callId}`, callId, rootNodeId: "n_open", nodes };
}

// ---------------------------------------------------------------------------
// 5. Hero transcript + feedback + assist (LLM, cached; deterministic fallbacks)
// ---------------------------------------------------------------------------

async function buildHeroTranscript(heroPath: TreeNode[]): Promise<{ speaker: Speaker; text: string }[]> {
  const beats = heroPath.map((n) => `- ${n.speaker.toUpperCase()} | "${n.title}" | ${n.description}`).join("\n");
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
// 6. Build calls + recordings + per-call trees
// ---------------------------------------------------------------------------

// Fixed base instant so startedAt values are deterministic across runs.
const BASE_MS = Date.parse("2026-06-27T17:00:00-07:00");

const FIRST = ["Maria", "Sam", "Priya", "Tom", "Lena", "David", "Aisha", "Carlos", "Nina", "Raj", "Emma", "Kevin", "Sofia", "Omar", "Hannah", "Leo"];
const LAST = ["Lopez", "Carter", "Nair", "Becker", "Park", "Idris", "Cohen", "Vance", "Okafor", "Reyes"];
const TITLES = ["VP of Operations", "Head of IT", "Director of Engineering", "COO", "VP of People", "Head of Customer Success", "CTO", "VP of Engineering", "Head of RevOps"];

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
  return { initialNodeId: path[0].id, finalNodeId: path[path.length - 1].id, steps };
}

interface BuiltPopulation {
  calls: Call[];
  trees: Record<string, Tree>;
  recordings: Record<string, Recording>;
  companies: Company[];
  samples: { callId: string; archetype: string; outcome: Outcome; recording: Recording }[];
}

/** A hand/LLM-authored "feature" call (hero, showcase): on the full tree_slack tree. */
interface SpecialCall {
  callId: string;
  realRecId: string;
  mockRecId: string;
  mockStartNode: string;
  prospectId: string;
  buyer: Buyer;
  sellerId: string;
  transcript: TranscriptSegment[];
  lengthMs: number;
  aiNotes: AssistCard | null;
  aiFeedback: AiFeedback | null;
}

function buildPopulation(
  fullTreeNodes: TreeNode[],
  stats: Map<string, NodeStat>,
  leafOutcome: Map<string, Outcome>,
  specials: Map<string, SpecialCall>,
): BuiltPopulation {
  const callRecords: Call[] = [];
  const trees: Record<string, Tree> = { [TREE_ID]: { id: TREE_ID, callId: HERO_CALL_ID, rootNodeId: seedTree.key, nodes: fullTreeNodes } };
  const recordings: Record<string, Recording> = {};
  const samples: BuiltPopulation["samples"] = [];

  // Companies accumulate the buyers assigned to them across all calls.
  const companyMap = new Map<string, Company>(
    prospects.map((p) => [p.id, { id: p.id, name: p.name, industry: p.industry, seats: p.seats, incumbent: p.incumbent, buyers: [] as Buyer[] }]),
  );

  // Prospect rotation: incumbent-shape calls only draw chat-incumbent prospects.
  const chatProspects = prospects.filter((p) => p.hasChatIncumbent);
  let allCursor = 0;
  let chatCursor = 0;
  const nonJane = salespeople.filter((s) => s.id !== FEATURED_SALESPERSON_ID);
  let nonJaneCursor = 0;

  let globalIndex = 0;

  for (const arc of calls) {
    for (let i = 0; i < arc.count; i++) {
      const special = specials.get(`${arc.key}#${i}`);
      const callId = special?.callId ?? `call_${arc.key.toLowerCase()}_${pad2(i + 1)}`;
      const realRecId = special?.realRecId ?? `rec_${arc.key.toLowerCase()}_${pad2(i + 1)}`;

      // Prospect (varies the company on each card).
      const prospect = special
        ? prospectById.get(special.prospectId)!
        : arc.incumbentShape
          ? chatProspects[chatCursor++ % chatProspects.length]
          : prospects[allCursor++ % prospects.length];

      // Buyer + persona (auto-assigned, never user-picked).
      let buyer: Buyer;
      if (special) {
        buyer = special.buyer;
      } else {
        const pool = personaByArchetype[arc.key] ?? ["buy_polly"];
        const personaId = pool[i % pool.length];
        const first = FIRST[globalIndex % FIRST.length];
        const last = LAST[Math.floor(globalIndex / FIRST.length) % LAST.length];
        buyer = {
          id: `buy_${pad3(globalIndex + 1)}`,
          name: `${first} ${last}`,
          title: TITLES[globalIndex % TITLES.length],
          personaId,
        };
      }
      companyMap.get(prospect.id)!.buyers.push(buyer);

      // Seller — Jane-heavy so the featured rep's pipeline is rich.
      const sellerId = special
        ? special.sellerId
        : globalIndex % 4 === 0
          ? FEATURED_SALESPERSON_ID
          : nonJane[nonJaneCursor++ % nonJane.length].id;

      // Tree — specials live on the shared full tree_slack; everyone else gets a
      // distinct per-call pruned tree for their prospect/deal type.
      let treeId: string;
      let pathNodes: TreeNode[];
      if (special) {
        treeId = TREE_ID;
        pathNodes = arc.path.map((id) => fullTreeNodes.find((n) => n.id === id)!);
      } else {
        const callTree = buildCallTree(callId, arc, prospect, stats, leafOutcome);
        trees[callTree.id] = callTree;
        treeId = callTree.id;
        const byId = new Map(callTree.nodes.map((n) => [n.id, n]));
        pathNodes = arc.path.map((id) => byId.get(id)!);
      }

      const transcript = special?.transcript ?? codeBuiltTranscript(pathNodes);
      const lengthMs = special?.lengthMs ?? pathNodes.length * STEP_MS;

      // Special transcripts are free-form (attribute steps to evenly-spaced
      // segments); population calls are 1 segment per node.
      const segIndexForNode = special
        ? (_id: string, pathIdx: number) =>
            Math.min(transcript.length - 1, Math.round((pathIdx / (pathNodes.length - 1 || 1)) * (transcript.length - 1)))
        : (_id: string, pathIdx: number) => pathIdx;

      const real: Recording = {
        id: realRecId,
        callId,
        treeId,
        isReal: true,
        isActive: false,
        startNodeId: pathNodes[0].id,
        stopNodeId: null,
        audioPath: `/data/audio/${realRecId}.webm`,
        lengthMs,
        transcript,
        traversal: buildTraversal(pathNodes, segIndexForNode),
        aiNotes: special?.aiNotes ?? null,
        aiFeedback: special?.aiFeedback ?? null,
      };
      recordings[realRecId] = real;
      const recordingIds = [realRecId];

      if (special) {
        const mock: Recording = {
          id: special.mockRecId,
          callId,
          treeId,
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
        companyId: prospect.id,
        salespersonId: sellerId,
        buyerId: buyer.id,
        startedAt: "", // assigned (interleaved) after the full population is built
        treeId,
        recordingIds,
      });

      if ((arc.key === "A" && i === 1) || (arc.key === "G" && i === 0)) {
        samples.push({ callId, archetype: arc.key, outcome: arc.outcome, recording: real });
      }

      globalIndex++;
    }
  }

  const companies = [...companyMap.values()].filter((c) => c.buyers.length > 0);
  return { calls: callRecords, trees, recordings, companies, samples };
}

/**
 * Assign startedAt so the list reads like a real history: the showcase is newest,
 * the hero second, and the rest round-robined across archetypes so outcomes
 * alternate instead of clustering.
 */
function assignDates(callRecords: Call[]) {
  const pinned = [showcase.callId, HERO_CALL_ID];
  const rest = callRecords.filter((c) => !pinned.includes(c.id));

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
  if (byId.size !== nodes.length) die("duplicate node ids in tree_slack");

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
  }

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

/** Per-call trees: light parent/child integrity + reachable root. */
function validateCallTree(tree: Tree) {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  if (!byId.has(tree.rootNodeId)) die(`${tree.id} missing root ${tree.rootNodeId}`);
  for (const n of tree.nodes) {
    for (const c of n.childIds) {
      if (!byId.has(c)) die(`${tree.id}: node ${n.id} childId ${c} does not resolve`);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Emit frontend tree.generated.ts (the static GEN_TREE — full master tree)
// ---------------------------------------------------------------------------

interface RawNodeOut {
  id: string;
  kind: "real" | "ai";
  title: string;
  description: string;
  success?: number;
  visits?: number;
  winRate?: number;
  onPath?: boolean;
  children?: RawNodeOut[];
}

function buildRawTree(nodes: TreeNode[], realSpineIds: Set<string>): RawNodeOut {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const build = (id: string): RawNodeOut => {
    const n = byId.get(id)!;
    const real = realSpineIds.has(id);
    const node: RawNodeOut = { id: n.id, kind: real ? "real" : "ai", title: n.title, description: n.description };
    if (real) node.onPath = true;
    else node.success = round2(n.successProbability);
    // Carry evidence so off-path branches can read "N calls · X%" instead of "AI".
    if (n.stats) {
      node.visits = n.stats.visits;
      node.winRate = round2(n.stats.winRate);
    }
    const children = n.childIds.map(build);
    if (children.length) node.children = children;
    return node;
  };
  return build(seedTree.key);
}

function emitFrontend(nodes: TreeNode[], realSpineIds: Set<string>): string {
  const raw = buildRawTree(nodes, realSpineIds);
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
  console.log("\n=== Master move graph (tree_slack) — per-move stats ===");
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
  for (const s of rec.transcript) console.log(`  [${s.speaker.toUpperCase().padEnd(6)}] ${s.text}`);
  if (rec.aiFeedback) console.log(`  practiceTargets: ${rec.aiFeedback.practiceTargets.map((t) => t.nodeId).join(", ") || "(none)"}`);
}

function printSamples(samples: BuiltPopulation["samples"], trees: Record<string, Tree>) {
  console.log("\n=== 2 sample population calls (distinct per-call trees) ===");
  for (const s of samples) {
    const tree = Object.values(trees).find((t) => t.callId === s.callId)!;
    const final = tree.nodes.find((n) => n.id === s.recording.traversal.finalNodeId)!;
    console.log(`  ${s.callId} (archetype ${s.archetype}, outcome=${s.outcome}, tree=${tree.id}, nodes=${tree.nodes.length}, finalP=${final.successProbability.toFixed(2)})`);
    console.log(`    path: ${[s.recording.traversal.initialNodeId, ...s.recording.traversal.steps.map((st) => st.toNodeId)].join(" → ")}`);
    console.log(`    transcript[0]: [${s.recording.transcript[0]?.speaker}] ${s.recording.transcript[0]?.text}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nCallTree seed build — ${DRY_RUN ? "DRY RUN (no files written)" : "FULL BUILD"}${REFRESH ? " (refresh: bypassing LLM cache)" : ""}`);

  console.log(`\nFlattened ${flat.length} master nodes.`);
  const { stats, leafOutcome } = deriveStats(flat);

  // Full tree_slack, rendered for the showcase prospect (Teams / 250 seats).
  const showcaseProspect = prospectById.get(showcase.prospectId)!;
  const fullNodes = buildFullTree(showcaseProspect, stats, leafOutcome);
  const fullById = new Map(fullNodes.map((n) => [n.id, n]));

  validate(fullNodes);
  console.log("Validation passed (tree_slack).");

  // Hero extras (LLM — the knock-loss "moment it slipped" call), on tree_slack.
  const heroArc = calls.find((c) => c.key === hero)!;
  const heroPath = heroArc.path.map((id) => fullById.get(id)!);

  console.log("\nGenerating hero transcript / feedback / assist…");
  const heroLines = await cachedLLM("hero_transcript", () => buildHeroTranscript(heroPath), () => fallbackHeroTranscript(heroPath));
  const heroFeedback = await cachedLLM("hero_feedback", () => buildHeroFeedback(heroPath), () => fallbackHeroFeedback());
  const heroAssist = await cachedLLM("hero_assist", () => buildHeroAssist(heroPath), () => fallbackHeroAssist(heroPath));
  const heroLen = Math.max(heroLines.length, heroPath.length) * STEP_MS;
  const heroTx = heroTranscript(heroLines, heroLen);

  // Showcase extras (hand-authored — the winning-line summarize demo), on tree_slack.
  const showcaseArc = calls.find((c) => c.key === showcase.archetype)!;
  const realSpineIds = new Set(showcaseArc.path);
  const showcasePath = showcaseArc.path.map((id) => fullById.get(id)!);
  const showcaseLen = Math.max(showcase.transcript.length, showcasePath.length) * STEP_MS;
  const showcaseTx = heroTranscript(showcase.transcript, showcaseLen);

  const specials = new Map<string, SpecialCall>([
    [`${hero}#0`, {
      callId: HERO_CALL_ID, realRecId: HERO_REAL_REC, mockRecId: HERO_MOCK_REC,
      mockStartNode: "n_incumbent", prospectId: HERO_PROSPECT_ID,
      buyer: heroBuyer, sellerId: salespeople[0].id,
      transcript: heroTx, lengthMs: heroLen, aiNotes: heroAssist, aiFeedback: heroFeedback,
    }],
    [`${showcase.archetype}#0`, {
      callId: showcase.callId, realRecId: "rec_showcase", mockRecId: "rec_showcase_mock",
      mockStartNode: "n_incumbent", prospectId: showcase.prospectId,
      buyer: showcase.buyer, sellerId: showcase.salespersonId,
      transcript: showcaseTx, lengthMs: showcaseLen, aiNotes: null, aiFeedback: showcase.feedback,
    }],
  ]);

  const population = buildPopulation(fullNodes, stats, leafOutcome, specials);
  assignDates(population.calls);

  for (const tree of Object.values(population.trees)) {
    if (tree.id !== TREE_ID) validateCallTree(tree);
  }

  const heroReal = population.recordings[HERO_REAL_REC];
  const showcaseReal = population.recordings["rec_showcase"];

  const totalDeal = dealValueOf(showcaseProspect);
  const seedStore: SeedStore = {
    _meta: {
      note: `Generated by seed/build.ts from seed/calltree.seed.ts. Seller org = ${sellerOrg.name}. Each call has its own tree (a per-prospect pruned view of the master graph); expectedValue = round(successProbability * prospect.dealValue), dealValue = seats * ${PER_SEAT}. Per-move win-rates are Beta-smoothed from ${calls.reduce((a, c) => a + c.count, 0)} call outcomes.`,
      dealValue,
    },
    companies: population.companies,
    salespeople,
    calls: population.calls,
    trees: population.trees,
    recordings: population.recordings,
  };

  printStats(fullNodes);
  printTranscript("SHOWCASE transcript (Summarize demo, win)", showcaseReal);
  printTranscript("Hero transcript (loss)", heroReal);
  printSamples(population.samples, population.trees);
  console.log(`\nPopulation: ${population.calls.length} calls, ${Object.keys(population.trees).length} trees, ${Object.keys(population.recordings).length} recordings, ${population.companies.length} companies.`);
  const janeCalls = population.calls.filter((c) => c.salespersonId === FEATURED_SALESPERSON_ID).length;
  console.log(`Featured rep ${FEATURED_SALESPERSON_ID}: ${janeCalls} calls. Total deal (showcase) = $${totalDeal.toLocaleString()}.`);

  if (DRY_RUN) {
    console.log("\n— DRY RUN complete. No files written. —\n");
    return;
  }

  await fs.mkdir(dirname(BACKEND_SEED), { recursive: true });
  await fs.writeFile(BACKEND_SEED, JSON.stringify(seedStore, null, 2));
  console.log(`\n✓ wrote ${BACKEND_SEED}`);

  await fs.mkdir(dirname(FE_GENERATED), { recursive: true });
  await fs.writeFile(FE_GENERATED, emitFrontend(fullNodes, realSpineIds));
  console.log(`✓ wrote ${FE_GENERATED}`);
  console.log("\n✓ seed build complete.\n");
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
