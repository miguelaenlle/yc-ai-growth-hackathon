// insights.ts — LLM-driven, citation-backed practice insights for ONE rep.
//
// Analyzes the rep's ACTUAL calls: for each, finds the fork where they played a
// low-win move vs. a clearly better sibling (bestRegretFork), pulls the EXACT
// transcript line where it happened (the citation quote), and aggregates recurring
// mistakes. An LLM then writes the "perfect practice call" narrative with inline
// [n] markers into those real citations. Everything is cached to insights.json and
// regenerated on demand from POST /admin/refresh.
//
// Deterministic fallback when OPENAI_API_KEY is absent: the citations are real data
// either way (quotes need no LLM), only the prose is templated instead of generated.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { store, getTree, recordingsForCall, companyName, toCallSummary } from "./store.js";
import { getPersona } from "./personas.js";
import { bestRegretFork, type RegretFork } from "./practice-reco.js";
import type {
  AiFeedback,
  Citation,
  Id,
  InsightsBundle,
  Recording,
  RecommendedPractice,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSIGHTS_PATH = join(__dirname, "data", "insights.json");

const FEATURED_REP = "sp_jane";
const pct = (x: number) => Math.round(x * 100);
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

// ---------------------------------------------------------------------------
// Data layer — real regret forks + the exact quote where each happened
// ---------------------------------------------------------------------------

interface CallFork {
  callId: Id;
  treeId: Id;
  company: string;
  buyer: { name: string; title: string };
  personaId: Id;
  outcome: "won" | "lost" | "open";
  fork: RegretFork;
  quote: string;
}

function buyerOf(buyerId: Id): { name: string; title: string; personaId?: Id } {
  for (const c of store.companies) {
    const b = c.buyers.find((x) => x.id === buyerId);
    if (b) return { name: b.name, title: b.title, personaId: b.personaId };
  }
  return { name: "Buyer", title: "" };
}

/** The exact transcript line where the rep played `nodeId` on this recording. */
function quoteForNode(rec: Recording, nodeId: Id): string {
  const step = rec.traversal.steps.find((s) => s.toNodeId === nodeId);
  if (step && rec.transcript[step.transcriptIndex]) return rec.transcript[step.transcriptIndex].text;
  return "";
}

/** Every losing-fork moment across the rep's calls, sorted by EV swing (worst first). */
function collectForks(salespersonId: Id): CallFork[] {
  const out: CallFork[] = [];
  for (const call of store.calls) {
    if (call.salespersonId !== salespersonId) continue;
    const tree = getTree(call.treeId);
    const real = recordingsForCall(call.id).find((r) => r.isReal);
    if (!tree || !real) continue;
    const summary = toCallSummary(call);
    if (summary.outcome === "won") continue; // practice pays off where it didn't win
    const fork = bestRegretFork(tree, real.traversal);
    if (!fork) continue;
    const buyer = buyerOf(call.buyerId);
    out.push({
      callId: call.id,
      treeId: call.treeId,
      company: companyName(call.companyId),
      buyer: { name: buyer.name, title: buyer.title },
      personaId: buyer.personaId ?? "buy_steve",
      outcome: summary.outcome,
      fork,
      quote: quoteForNode(real, fork.takenNodeId),
    });
  }
  return out.sort((a, b) => b.fork.gapEV - a.fork.gapEV);
}

function citationFrom(id: number, cf: CallFork): Citation {
  return {
    id,
    callId: cf.callId,
    company: cf.company,
    buyer: cf.buyer,
    outcome: cf.outcome,
    nodeId: cf.fork.takenNodeId,
    nodeTitle: cf.fork.forkTitle,
    takenTitle: cf.fork.takenTitle,
    betterTitle: cf.fork.bestTitle,
    winTaken: cf.fork.takenP,
    winBest: cf.fork.bestP,
    evGap: cf.fork.gapEV,
    quote: cf.quote,
  };
}

// ---------------------------------------------------------------------------
// LLM (gpt-4o-mini, JSON; same pattern as analysis.ts). Returns null on any failure.
// ---------------------------------------------------------------------------

async function callLLM(system: string, user: string): Promise<Record<string, unknown> | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      console.error("[insights] OpenAI failed:", await res.text());
      return null;
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(data.choices[0].message.content) as Record<string, unknown>;
  } catch (e) {
    console.error("[insights] LLM error:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateInsights(salespersonId = FEATURED_REP): Promise<InsightsBundle> {
  const sp = store.salespeople.find((s) => s.id === salespersonId);
  const forks = collectForks(salespersonId);

  // Per-call recommended-start (every losing call gets one; quotes are real).
  const perCall: Record<Id, NonNullable<AiFeedback["recommendedStart"]>> = {};
  for (const cf of forks) {
    const sameMove = forks.filter((x) => x.fork.takenTitle === cf.fork.takenTitle).length;
    const recur =
      sameMove > 1 ? ` You make the ${cf.fork.takenTitle} on ${sameMove} of your calls — a pattern worth drilling.` : "";
    perCall[cf.callId] = {
      nodeId: cf.fork.forkNodeId,
      reason: forkReason(cf.fork) + " Start here.",
      description: forkReason(cf.fork) + recur,
      citations: [citationFrom(1, cf)],
    };
  }

  // Perfect practice call — the single worst fork, plus citations from other calls
  // sharing the same mistake (the recurring pattern → [1][2][3]).
  const top = forks[0];
  const usedLLM = !!process.env.OPENAI_API_KEY && forks.length > 0;

  if (!top || !sp) {
    const empty: RecommendedPractice = {
      salespersonId,
      salespersonName: sp?.name ?? salespersonId,
      callId: "",
      treeId: "",
      startNodeId: "n_open",
      startNodeTitle: "Opening",
      personaId: "buy_steve",
      personaName: getPersona("buy_steve")?.name ?? "Skeptical Steve",
      headline: "No costly missed move yet",
      reasons: ["Once there are losing calls to learn from, this will recommend the moment to drill."],
      citations: [],
    };
    return persist({ salespersonId, perfectPractice: empty, perCall, usedLLM: false });
  }

  const sameMistake = forks.filter((x) => x.fork.takenTitle === top.fork.takenTitle);
  const citeSources = [top, ...sameMistake.filter((x) => x.callId !== top.callId)].slice(0, 4);
  const citations = citeSources.map((cf, i) => citationFrom(i + 1, cf));
  const personaName = getPersona(top.personaId)?.name ?? top.personaId;

  // Build the narrative (LLM if available, else grounded template).
  const llm = await buildNarrative(sp.name, top, sameMistake.length, citations, personaName);

  const perfectPractice: RecommendedPractice = {
    salespersonId,
    salespersonName: sp.name,
    callId: top.callId,
    treeId: top.treeId,
    startNodeId: top.fork.forkNodeId,
    startNodeTitle: top.fork.forkTitle,
    personaId: top.personaId,
    personaName,
    headline: llm.headline,
    reasons: llm.reasons,
    citations,
    call: toCallSummary(store.calls.find((c) => c.id === top.callId)!),
  };

  return persist({ salespersonId, perfectPractice, perCall, usedLLM: !!llm.usedLLM });
}

function forkReason(f: RegretFork): string {
  return `You played the ${f.takenTitle} (${pct(f.takenP)}% win) at the ${f.forkTitle} — the ${f.bestTitle} wins ${pct(
    f.bestP,
  )}%, about a ${money(f.gapEV)} swing in expected value.`;
}

async function buildNarrative(
  repName: string,
  top: CallFork,
  recurCount: number,
  citations: Citation[],
  personaName: string,
): Promise<{ headline: string; reasons: string[]; usedLLM: boolean }> {
  // Translate internal numbers into plain language for the layperson-facing copy.
  const inTen = (p: number) => Math.max(1, Math.min(9, Math.round(p * 10)));
  const top0 = citations[0];
  const allMarkers = citations.map((c) => `[${c.id}]`).join("");
  const fallback = {
    headline: `You keep bashing the tool the customer already uses`,
    reasons: [
      recurCount > 1
        ? `On ${recurCount} of your recent calls, the moment a prospect mentioned the tool they already use, you jumped to bashing it — and the deals went cold ${allMarkers}.`
        : `On the ${top.company} deal, when the prospect mentioned the tool they already use, you jumped to bashing it — and the deal went cold [1].`,
      `Top reps do the opposite: they ask what's frustrating about the current setup and let the prospect talk themselves into switching. That wins about ${inTen(top.fork.bestP)} of 10 times; bashing it wins about ${inTen(top.fork.takenP)} in 10 [1].`,
      top0
        ? `On the ${top0.company} call, ${top0.buyer.name} mentioned their current tool — you told them it was bloated and slow, and they went quiet [1].`
        : `Replay that moment and try asking about their problems instead.`,
    ],
    usedLLM: false,
  };

  const cites = citations
    .map((c) => `[${c.id}] ${c.company} (${c.outcome}) — buyer ${c.buyer.name} (${c.buyer.title}). The rep said: "${c.quote}". Internal stats: rep's move won ${pct(c.winTaken)}%, the better move (asking about their problems) won ${pct(c.winBest)}%.`)
    .join("\n");

  const system =
    "You are a sales coach writing for a brand-new salesperson who has NEVER seen a sales dashboard. " +
    "Write in plain, everyday English a layperson can read at a glance. STRICT RULES:\n" +
    "- NEVER print internal jargon: no move names (e.g. 'Knock Incumbent', 'Find Pain'), no persona names (e.g. 'Status-Quo Sam'), no 'EV swing', no dollar figures, no 'fork' or 'node'.\n" +
    "- NEVER print raw percentages like '7%' or '94%'. Translate win-rates to plain odds like 'about 9 of 10 times' or '1 in 10'.\n" +
    "- Describe what the rep DID in plain words (e.g. 'you bashed the tool they already use'), not by its label.\n" +
    "- Ground everything ONLY in the data given; do not invent numbers, quotes, buyers, or calls.\n" +
    "- Keep [n] markers that map to the numbered citations. Respond ONLY with JSON.";
  const user =
    `REP: ${repName}\n` +
    `THE HABIT: when a prospect mentions the tool they already use, this rep attacks it instead of asking what's wrong with it. ` +
    `That approach wins about ${inTen(top.fork.takenP)} in 10; asking about their problems wins about ${inTen(top.fork.bestP)} of 10.\n` +
    `HOW OFTEN: they did this on ${recurCount} recent call(s).\n` +
    `CITATIONS (real transcript quotes — translate the stats, never echo the raw numbers):\n${cites}\n\n` +
    `Return JSON in this exact shape:\n` +
    `{\n` +
    `  "headline": string — one plain sentence describing the HABIT (not a move name or company), e.g. "You keep trash-talking the customer's current tool",\n` +
    `  "reasons": [\n` +
    `    string — THE PATTERN: how many calls it happened on and what went wrong, end with one marker for EVERY losing call: ${allMarkers},\n` +
    `    string — WHAT WORKS INSTEAD: in human terms, using plain odds (e.g. 'about 9 of 10'), end with [1],\n` +
    `    string — ONE CONCRETE STORY: use citation [1] (the exact call shown below to replay) — name that buyer and what they said/did, end with [1]\n` +
    `  ]\n` +
    `}`;

  const parsed = await callLLM(system, user);
  if (!parsed) return fallback;
  const headline = typeof parsed.headline === "string" ? parsed.headline : fallback.headline;
  const reasons =
    Array.isArray(parsed.reasons) && parsed.reasons.every((r) => typeof r === "string") && parsed.reasons.length
      ? (parsed.reasons as string[])
      : fallback.reasons;
  return { headline, reasons, usedLLM: true };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist(partial: Omit<InsightsBundle, "generatedAt" | "usedLLM"> & { usedLLM: boolean }): InsightsBundle {
  const bundle: InsightsBundle = { generatedAt: new Date().toISOString(), ...partial };
  writeFileSync(INSIGHTS_PATH, JSON.stringify(bundle, null, 2), "utf-8");
  return bundle;
}

export function loadInsights(): InsightsBundle | null {
  try {
    return JSON.parse(readFileSync(INSIGHTS_PATH, "utf-8")) as InsightsBundle;
  } catch {
    return null;
  }
}
