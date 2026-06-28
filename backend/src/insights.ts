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
  const citeSources = [top, ...sameMistake.filter((x) => x.callId !== top.callId)].slice(0, 3);
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
  const fallback = {
    headline: `Replay the ${top.fork.forkTitle} on the ${top.company} deal`,
    reasons: [
      `You played the ${top.fork.takenTitle} (${pct(top.fork.takenP)}% win) at the ${top.fork.forkTitle} — the ${top.fork.bestTitle} wins ${pct(top.fork.bestP)}%, about a ${money(top.fork.gapEV)} swing. [1]`,
      recurCount > 1
        ? `It's a pattern: you make the ${top.fork.takenTitle} on ${recurCount} of your calls${citations.length > 1 ? " " + citations.slice(1).map((c) => `[${c.id}]`).join("") : ""}.`
        : `It's the single biggest missed move across your recent calls.`,
      `You'll face ${personaName} — the buyer you had on that call.`,
    ],
    usedLLM: false,
  };

  const cites = citations
    .map((c) => `[${c.id}] ${c.company} (${c.outcome}) — at the ${c.nodeTitle}, the rep said: "${c.quote}" (played ${c.takenTitle} ${pct(c.winTaken)}% vs ${c.betterTitle} ${pct(c.winBest)}%)`)
    .join("\n");

  const system =
    "You are a sharp sales coach. Write a SHORT, punchy practice recommendation grounded ONLY in the data given. " +
    "Cite evidence with [n] markers that map to the numbered citations. Do not invent numbers, quotes, or calls. Respond ONLY with JSON.";
  const user =
    `REP: ${repName}\n` +
    `BIGGEST MISTAKE: played "${top.fork.takenTitle}" (${pct(top.fork.takenP)}% win) at the "${top.fork.forkTitle}" on the ${top.company} deal, ` +
    `where "${top.fork.bestTitle}" wins ${pct(top.fork.bestP)}% — a ${money(top.fork.gapEV)} EV swing. Buyer persona: ${personaName}.\n` +
    `RECURRENCE: makes the "${top.fork.takenTitle}" move on ${recurCount} call(s).\n` +
    `CITATIONS (real transcript quotes):\n${cites}\n\n` +
    `Return JSON: { "headline": string (<= 8 words, names the move + company), ` +
    `"reasons": string[] (2-3 short lines; embed [n] markers citing the quotes above; mention the EV swing, the recurring pattern, and the buyer they'll face) }`;

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
