// practice-reco.ts — the practice-recommendation brain, grounded in TREE + OUTCOME
// data (what each move actually wins across the call population), not a synthetic
// stats file.
//
// System 1 (buildRecommendedPractice): the per-rep "perfect practice call". Scans
// the rep's lost/open calls, finds the single fork where they played a low-win move
// while a sibling move wins far more often, and recommends replaying that exact
// moment against the buyer persona they actually faced. The biggest realized-EV
// "regret gap" wins. Reasons cite the real per-move win-rates.
//
// System 2 (buildAiFeedback): for one recording, the same sibling-gap picks the
// "start practicing here" node; practice targets come from the call's in-call
// signal weakness on the path it actually walked.
//
// Everything here is deterministic (no LLM, no stats file) so the reasons are
// grounded directly in the tree's win-rates and EVs.

import { store, getTree, recordingsForCall, companyName, toCallSummary } from "./store.js";
import { getPersona } from "./personas.js";
import { getNodeChildren, getPathFromTraversal, getWeakNodes } from "./tree-ops.js";
import type {
  AiFeedback,
  Id,
  PracticeTarget,
  RecommendedPractice,
  SalespersonListItem,
  Traversal,
  Tree,
} from "./types.js";

const pct = (x: number): number => Math.round(x * 100);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const money = (n: number): string => `$${Math.round(n).toLocaleString()}`;

/** Metric-appropriate phrasing — high hesitation is bad; low conf/enthusiasm is bad. */
function metricMoment(metric: PracticeTarget["metric"]): string {
  if (metric === "hesitation") return "hesitation spiked";
  if (metric === "confidence") return "confidence dropped";
  return "enthusiasm dipped";
}

/** The persona assigned to a call's buyer (auto-assigned in the seed; never picked). */
function buyerPersonaId(buyerId: Id): Id | undefined {
  for (const c of store.companies) {
    const b = c.buyers.find((x) => x.id === buyerId);
    if (b) return b.personaId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Regret fork — the decision point where a better move was clearly available
// ---------------------------------------------------------------------------

export interface RegretFork {
  forkNodeId: Id;
  forkTitle: string;
  takenNodeId: Id; // the move node the rep actually played (for the transcript quote)
  takenTitle: string;
  takenP: number;
  bestTitle: string;
  bestNodeId: Id;
  bestP: number;
  gapEV: number; // bestChild.EV − takenChild.EV (realized-value swing)
}

/**
 * Walk the path the call actually took and find the fork with the biggest
 * realized-EV gap between the move the rep played and the best available sibling.
 * Returns null when every move taken was already the best (or no real forks exist).
 */
export function bestRegretFork(tree: Tree, traversal: Traversal): RegretFork | null {
  const path = getPathFromTraversal(tree, traversal);
  let best: RegretFork | null = null;

  for (let i = 0; i < path.length - 1; i++) {
    const fork = path[i];
    const taken = path[i + 1];
    const children = getNodeChildren(tree, fork.id);
    if (children.length < 2) continue; // no alternative move existed

    const bestChild = children.reduce((a, b) => (b.successProbability > a.successProbability ? b : a));
    if (bestChild.id === taken.id) continue; // already played the best move

    const gapEV = bestChild.expectedValue - taken.expectedValue;
    if (gapEV <= 0) continue;

    if (!best || gapEV > best.gapEV) {
      best = {
        forkNodeId: fork.id,
        forkTitle: fork.title,
        takenNodeId: taken.id,
        takenTitle: taken.title,
        takenP: taken.successProbability,
        bestTitle: bestChild.title,
        bestNodeId: bestChild.id,
        bestP: bestChild.successProbability,
        gapEV,
      };
    }
  }
  return best;
}

function forkReason(f: RegretFork): string {
  return `You played the ${f.takenTitle} (${pct(f.takenP)}% win) at the ${f.forkTitle} — the ${f.bestTitle} wins ${pct(
    f.bestP,
  )}%, about a ${money(f.gapEV)} swing in expected value.`;
}

// ---------------------------------------------------------------------------
// GET /salespeople — rep list, win-rate computed from their actual calls
// ---------------------------------------------------------------------------

export function listSalespeople(): SalespersonListItem[] {
  return store.salespeople.map((sp) => {
    const mine = store.calls.filter((c) => c.salespersonId === sp.id).map(toCallSummary);
    const decided = mine.filter((c) => c.outcome !== "open");
    const wins = mine.filter((c) => c.outcome === "won").length;
    return {
      id: sp.id,
      name: sp.name,
      totalCalls: mine.length,
      winRate: decided.length ? wins / decided.length : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// System 1 — the per-rep "perfect practice call", from real call outcomes
// ---------------------------------------------------------------------------

interface RepFork {
  callId: Id;
  treeId: Id;
  company: string;
  personaId: Id;
  fork: RegretFork;
}

/** The rep's biggest missed move across their lost/open calls (or null). */
function biggestRegret(salespersonId: Id): RepFork | null {
  let best: RepFork | null = null;
  for (const call of store.calls) {
    if (call.salespersonId !== salespersonId) continue;
    const tree = getTree(call.treeId);
    if (!tree) continue;
    const real = recordingsForCall(call.id).find((r) => r.isReal);
    if (!real) continue;
    // Focus on calls that didn't clearly win — that's where practice pays off.
    const summary = toCallSummary(call);
    if (summary.outcome === "won") continue;

    const fork = bestRegretFork(tree, real.traversal);
    if (!fork) continue;
    if (!best || fork.gapEV > best.fork.gapEV) {
      best = {
        callId: call.id,
        treeId: call.treeId,
        company: companyName(call.companyId),
        personaId: buyerPersonaId(call.buyerId) ?? "buy_steve",
        fork,
      };
    }
  }
  return best;
}

export function buildRecommendedPractice(salespersonId: Id): RecommendedPractice | null {
  const sp = store.salespeople.find((s) => s.id === salespersonId);
  if (!sp) return null;

  const regret = biggestRegret(salespersonId);

  // Fallback: rep has no losing fork (all wins / no calls). Recommend their most
  // recent call's opening so the demo always has something to practice.
  if (!regret) {
    const recent = store.calls
      .filter((c) => c.salespersonId === salespersonId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const tree = recent ? getTree(recent.treeId) : undefined;
    const start = tree?.nodes.find((n) => n.id === "n_incumbent") ?? tree?.nodes[0];
    const personaId = recent ? buyerPersonaId(recent.buyerId) ?? "buy_steve" : "buy_steve";
    return {
      salespersonId,
      salespersonName: sp.name,
      callId: recent?.id ?? "",
      treeId: recent?.treeId ?? "",
      startNodeId: start?.id ?? "n_open",
      startNodeTitle: start?.title ?? "Opening",
      personaId,
      personaName: getPersona(personaId)?.name ?? personaId,
      headline: "Sharpen your strongest line",
      reasons: ["No costly missed move in your recent calls — drill to keep the edge."],
    };
  }

  const f = regret.fork;
  const personaName = getPersona(regret.personaId)?.name ?? regret.personaId;

  return {
    salespersonId,
    salespersonName: sp.name,
    callId: regret.callId,
    treeId: regret.treeId,
    startNodeId: f.forkNodeId,
    startNodeTitle: f.forkTitle,
    personaId: regret.personaId,
    personaName,
    headline: `Replay the ${f.forkTitle} on the ${regret.company} deal`,
    reasons: [
      forkReason(f),
      `It's the single biggest missed move across your recent calls.`,
      `You'll face ${personaName} — the buyer you had on that call.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// System 2 — per-recording feedback (grounded in this call's tree + path)
// ---------------------------------------------------------------------------

/** Build full AiFeedback for one recording from its tree + the path it walked. */
export function buildAiFeedback(
  tree: Tree,
  traversal: Traversal,
  opts?: { limit?: number },
): AiFeedback {
  const path = getPathFromTraversal(tree, traversal);
  const pathIds = new Set(path.map((n) => n.id));
  const fork = bestRegretFork(tree, traversal);

  // Practice targets: the weakest moments (by in-call signal) ON the path walked.
  const limit = opts?.limit ?? 3;
  const weak = getWeakNodes(tree).filter((w) => pathIds.has(w.node.id)).slice(0, limit);
  const practiceTargets: PracticeTarget[] = weak.map((w) => ({
    nodeId: w.node.id,
    reason: `${cap(metricMoment(w.worstMetric))} at the ${w.node.title} (${pct(w.node.successProbability)}% win at this move).`,
    drill: `Practice handling "${w.node.description}" with stronger ${w.worstMetric}.`,
    metric: w.worstMetric,
    score: Math.round((1 - w.node.successProbability) * 1000) / 1000,
  }));

  // Strengths: the seller moves on the path that actually convert well.
  const strengths = path
    .filter((n) => n.speaker === "seller" && n.successProbability >= 0.7)
    .slice(0, 2)
    .map((n) => `${n.title} — a ${pct(n.successProbability)}% move`);
  if (strengths.length === 0) strengths.push("Reached the decision point and kept the buyer engaged");

  const weaknesses: string[] = [];
  if (fork) weaknesses.push(forkReason(fork));
  for (const t of practiceTargets) {
    if (weaknesses.length >= 3) break;
    if (!fork || t.nodeId !== fork.forkNodeId) weaknesses.push(t.reason);
  }

  const summary = fork
    ? `The pivotal moment was the ${fork.forkTitle}: you played the ${fork.takenTitle} (${pct(
        fork.takenP,
      )}% win) where the ${fork.bestTitle} converts ${pct(fork.bestP)}% — about a ${money(fork.gapEV)} swing.`
    : `Clean execution — no single fork cost you much on this call.`;

  const recommendedStart = fork
    ? { nodeId: fork.forkNodeId, reason: `${forkReason(fork)} Start here.` }
    : weak[0]
      ? { nodeId: weak[0].node.id, reason: `${cap(metricMoment(weak[0].worstMetric))} at the ${weak[0].node.title} — start here.` }
      : undefined;

  return { summary, strengths, weaknesses, practiceTargets, recommendedStart };
}
