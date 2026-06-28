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

/**
 * Every regret-fork moment across the rep's calls, sorted by EV swing (worst first).
 * Includes won calls too — a won call can still have a missed-best-move moment worth
 * drilling (`outcome` is recorded so copy can be framed accordingly). The Perfect
 * Practice card filters won calls out before picking its single worst fork.
 */
function collectForks(salespersonId: Id): CallFork[] {
  const out: CallFork[] = [];
  for (const call of store.calls) {
    if (call.salespersonId !== salespersonId) continue;
    const tree = getTree(call.treeId);
    const real = recordingsForCall(call.id).find((r) => r.isReal);
    if (!tree || !real) continue;
    const summary = toCallSummary(call);
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
    takenWins: cf.fork.takenWins,
    takenVisits: cf.fork.takenVisits,
    bestWins: cf.fork.bestWins,
    bestVisits: cf.fork.bestVisits,
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

export async function generateInsights(
  salespersonId = FEATURED_REP,
  opts: { perCallLimit?: number } = {},
): Promise<InsightsBundle> {
  const sp = store.salespeople.find((s) => s.id === salespersonId);
  const forks = collectForks(salespersonId);

  // Optionally scope the expensive per-call LLM pass to the rep's most-recent N calls
  // (by startedAt). The Perfect Practice selection below still considers ALL forks.
  let recentIds: Set<Id> | null = null;
  if (opts.perCallLimit && opts.perCallLimit > 0) {
    recentIds = new Set(
      store.calls
        .filter((c) => c.salespersonId === salespersonId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, opts.perCallLimit)
        .map((c) => c.id),
    );
  }
  const forksToNarrate = recentIds ? forks.filter((f) => recentIds!.has(f.callId)) : forks;

  // Per-call recommended-start (every regret fork gets one; quotes are real).
  // [1] is always THIS call's own moment; [2..] are other calls with the same mistake
  // (the recurring pattern), so the card cites both the current call and history.
  const perCall: Record<Id, NonNullable<AiFeedback["recommendedStart"]>> = {};
  await Promise.all(
    forksToNarrate.map(async (cf) => {
      const sameMove = forks.filter((x) => x.fork.takenTitle === cf.fork.takenTitle);
      // Other calls with the same missed-best move, deduped by company (the same
      // prospect can appear on several calls — don't cite it twice). Biggest gaps first.
      const seen = new Set([cf.company]);
      const others = sameMove.filter((x) => {
        if (x.callId === cf.callId || seen.has(x.company)) return false;
        seen.add(x.company);
        return true;
      });
      const citeSources = [cf, ...others].slice(0, 4);
      const citations = citeSources.map((c, i) => citationFrom(i + 1, c));
      const narrative = await buildPerCallNarrative(cf, citations);
      perCall[cf.callId] = {
        nodeId: cf.fork.forkNodeId,
        heading: narrative.heading,
        reason: narrative.reasons.join(" "),
        reasons: narrative.reasons,
        citations,
      };
    }),
  );

  // When scoped to recent calls, keep older calls' last-good per-call copy by merging
  // the freshly-narrated entries over the previously-persisted ones.
  const mergedPerCall = recentIds ? { ...(loadInsights()?.perCall ?? {}), ...perCall } : perCall;

  // Perfect practice call — the single worst fork among calls that DIDN'T win (a won
  // call's small-gap fork shouldn't outrank a real loss), plus citations from other
  // calls sharing the same mistake (the recurring pattern → [1][2][3][4]).
  const top = forks.find((f) => f.outcome !== "won");
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
    return persist({ salespersonId, perfectPractice: empty, perCall: mergedPerCall, usedLLM: false });
  }

  // Only count/cite the non-won calls — the Perfect Practice copy says "all were lost".
  const sameMistake = forks.filter((x) => x.fork.takenTitle === top.fork.takenTitle && x.outcome !== "won");
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

  return persist({ salespersonId, perfectPractice, perCall: mergedPerCall, usedLLM: !!llm.usedLLM });
}

async function buildNarrative(
  repName: string,
  top: CallFork,
  recurCount: number,
  citations: Citation[],
  personaName: string,
): Promise<{ headline: string; reasons: string[]; usedLLM: boolean }> {
  const top0 = citations[0];
  const allMarkers = citations.map((c) => `[${c.id}]`).join("");
  const took = `${top.fork.takenWins} of ${top.fork.takenVisits} times`;
  const better = `${top.fork.bestWins} of ${top.fork.bestVisits} times`;
  const fallback = {
    headline: `You keep bashing the tool the customer already uses`,
    reasons: [
      recurCount > 1
        ? `On ${recurCount} of your recent calls, the moment a prospect mentioned the tool they already use, you jumped to bashing it — and the deals went cold ${allMarkers}.`
        : `On the ${top.company} deal, when the prospect mentioned the tool they already use, you jumped to bashing it — and the deal went cold [1].`,
      `Top reps do the opposite: they ask what's frustrating about the current setup and let the prospect talk themselves into switching. That won ${better}; bashing it won ${took} [1].`,
      top0
        ? `On the ${top0.company} call, ${top0.buyer.name} mentioned their current tool — you told them it was bloated and slow, and they went quiet [1].`
        : `Replay that moment and try asking about their problems instead.`,
    ],
    usedLLM: false,
  };

  const cites = citations
    .map((c) => `[${c.id}] ${c.company} (${c.outcome}) — buyer ${c.buyer.name} (${c.buyer.title}). The rep said: "${c.quote}". Real counts: rep's move won ${c.takenWins} of ${c.takenVisits} times, the better move (asking about their problems) won ${c.bestWins} of ${c.bestVisits} times.`)
    .join("\n");

  const system =
    "You are a sales coach writing for a brand-new salesperson who has NEVER seen a sales dashboard. " +
    "Write in plain, everyday English a layperson can read at a glance. STRICT RULES:\n" +
    "- NEVER print internal jargon: no move names (e.g. 'Knock Incumbent', 'Find Pain'), no persona names (e.g. 'Status-Quo Sam'), no 'EV swing', no dollar figures, no 'fork' or 'node'.\n" +
    "- State how often a move works using the EXACT real counts given, phrased as 'won X of Y times'. NEVER use percentages and NEVER invent or round the counts.\n" +
    "- Describe what the rep DID in plain words (e.g. 'you bashed the tool they already use'), not by its label.\n" +
    "- Ground everything ONLY in the data given; do not invent numbers, quotes, buyers, or calls.\n" +
    "- Keep [n] markers that map to the numbered citations. Respond ONLY with JSON.";
  const user =
    `REP: ${repName}\n` +
    `THE HABIT: when a prospect mentions the tool they already use, this rep attacks it instead of asking what's wrong with it. ` +
    `That move won ${took}; asking about their problems won ${better}. Use these EXACT counts, phrased "won X of Y times".\n` +
    `HOW OFTEN: they did this on ${recurCount} recent call(s).\n` +
    `CITATIONS (real transcript quotes — use the exact counts, never percentages):\n${cites}\n\n` +
    `Return JSON in this exact shape:\n` +
    `{\n` +
    `  "headline": string — one plain sentence describing the HABIT (not a move name or company), e.g. "You keep trash-talking the customer's current tool",\n` +
    `  "reasons": [\n` +
    `    string — THE PATTERN: how many calls it happened on and what went wrong, end with one marker for EVERY losing call: ${allMarkers},\n` +
    `    string — WHAT WORKS INSTEAD: in human terms, with the exact counts (asking about problems won ${better}; bashing it won ${took}), end with [1],\n` +
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

/**
 * Plain-language, outcome-aware narrative for ONE call's "Practice from here" card.
 * Same layperson style as buildNarrative: [1] is this call's own moment, [2..] are other
 * calls with the same mistake. Won calls are framed as "a common slip you got past",
 * lost/open calls as "where the call fell off". Falls back to a grounded template.
 */
async function buildPerCallNarrative(
  cf: CallFork,
  citations: Citation[],
): Promise<{ heading: string; reasons: string[] }> {
  const otherMarkers = citations.slice(1).map((c) => `[${c.id}]`).join("");
  const othersCited = citations.length - 1; // distinct other calls we can point at
  const otherCalls = `${othersCited} other call${othersCited === 1 ? "" : "s"}`;
  const won = cf.outcome === "won";
  const took = `${cf.fork.takenWins} of ${cf.fork.takenVisits} times`;
  const better = `${cf.fork.bestWins} of ${cf.fork.bestVisits} times`;

  // Deterministic plain-language bullets when the LLM is unavailable.
  const fallback = {
    heading: won ? "A moment you got past" : "Where the call started to slip",
    reasons: [
      won
        ? `You **won** — but a stronger move was right here. [1]`
        : `This is **where the call fell off**. [1]`,
      `Asking **what's frustrating** about their current tool won **${better}**; your move won **${took}**. [1]`,
      ...(othersCited > 0 ? [`Same slip on **${otherCalls}**. ${otherMarkers}`] : []),
    ],
  };

  const cites = citations
    .map((c) => `[${c.id}] ${c.company} (${c.outcome}) — buyer ${c.buyer.name} (${c.buyer.title}). The rep said: "${c.quote}". Real counts: this move won ${c.takenWins} of ${c.takenVisits} times, the better move ("${c.betterTitle}") won ${c.bestWins} of ${c.bestVisits} times.`)
    .join("\n");

  const system =
    "You are a sales coach writing for a brand-new salesperson who has NEVER seen a sales dashboard. " +
    "Write in plain, everyday English a layperson can read at a glance. STRICT RULES:\n" +
    "- NEVER print internal jargon: no move names (e.g. 'Coexist', 'Find Pain', 'Knock Incumbent'), no persona names, no 'EV swing', no dollar figures, no 'fork' or 'node'.\n" +
    "- State how often a move works using the EXACT real counts given, phrased as 'won X of Y times'. NEVER use percentages and NEVER invent or round the counts.\n" +
    "- Describe what the rep DID and the BETTER move in plain words (translate the move labels into a concrete action, e.g. 'ask what's frustrating about their current tool').\n" +
    "- Use **bold** (markdown) to emphasize the ONE key phrase in each bullet — the action or the 'X of Y times' count. Keep bullets SHORT (max ~16 words).\n" +
    "- Ground everything ONLY in the data given; do not invent numbers, quotes, buyers, or calls.\n" +
    "- Keep [n] markers that map to the numbered citations. Respond ONLY with JSON.";
  const user =
    `THIS CALL: ${cf.company} — outcome: ${cf.outcome.toUpperCase()}.\n` +
    `THE MOMENT (citation [1]): the rep said "${cf.quote}". The smarter move here was "${cf.fork.bestTitle}" (translate that into a plain action).\n` +
    `REAL COUNTS: the move taken won ${took}; the better move won ${better}. Use these EXACT counts, phrased "won X of Y times".\n` +
    `FRAMING: ${won
      ? "This call was WON — frame it as a good outcome where an even stronger move was available; a common slip worth drilling. Be encouraging."
      : "This call was LOST/STALLED — frame it as the moment where the call started to fall off."}\n` +
    `HOW OFTEN: besides this call, the same slip shows up on ${otherCalls} you can cite.\n` +
    `CITATIONS:\n${cites}\n\n` +
    `Return JSON in this exact shape:\n` +
    `{\n` +
    `  "heading": string — a short plain phrase naming the MOMENT (4-7 words, no move labels), e.g. "When their current tool came up",\n` +
    `  "reasons": [  // 2-3 SHORT bullets, each with one **bold** phrase\n` +
    `    string — WHAT HAPPENED here (${won ? "you won, but…" : "this is where it slipped"}), end with [1],\n` +
    `    string — THE BETTER MOVE in plain words, with the exact counts (the better move won ${better}; your move won ${took}), end with [1]${othersCited > 0 ? `,\n    string — it RECURS: exactly "Same slip on **${otherCalls}**." then the markers ${otherMarkers}` : ""}\n` +
    `  ]\n` +
    `}`;

  const parsed = await callLLM(system, user);
  if (!parsed) return fallback;
  const heading = typeof parsed.heading === "string" && parsed.heading.trim() ? parsed.heading : fallback.heading;
  const reasons =
    Array.isArray(parsed.reasons) && parsed.reasons.every((r) => typeof r === "string") && parsed.reasons.length
      ? (parsed.reasons as string[])
      : fallback.reasons;
  return { heading, reasons };
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
