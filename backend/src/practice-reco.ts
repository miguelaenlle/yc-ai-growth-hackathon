// practice-reco.ts — the practice-recommendation brain for both systems.
//
// System 1 (buildRecommendedPractice): a per-rep "perfect practice call" derived
// deterministically from the rep's BASELINE stats — the persona they perform
// worst against + a start node exercising their weakest skill, on a representative
// call of theirs. Reasons cite REAL baseline numbers, nothing invented.
//
// System 2 (rankPracticeTargets): blends THIS call's signal weakness (getWeakNodes)
// with the rep's HISTORICAL stats (per-node fail rate, weak-skill mapping) to rank
// practice targets and pick one top "start practicing here" node.
//
// Everything here is deterministic (no LLM) so it stays fast and works without an
// OPENAI_API_KEY — the reasons are grounded directly in the stat values.

import { store, getTree } from "./store.js";
import { getPersona } from "./personas.js";
import { getNodeById, getWeakNodes } from "./tree-ops.js";
import {
  getStats,
  overallWinRate,
  skillFailRate,
  weakestSkill,
  type SalespersonStats,
} from "./salesperson-stats.js";
import type {
  Id,
  PracticeTarget,
  RecommendedPractice,
  SalespersonListItem,
  Tree,
} from "./types.js";

/**
 * Each taxonomy skill → the shared-tree node that best exercises it. The demo
 * trees all share these node ids (see CLAUDE.md), so this map is stable.
 */
export const SKILL_NODE_MAP: Record<string, Id> = {
  discovery: "n_disc",
  "objection-handling": "n_incumbent",
  pricing: "n_price",
  closing: "n_pilot",
  rapport: "n_open",
};

/** Inverse of SKILL_NODE_MAP: node id → the skill it exercises (when mapped). */
const NODE_SKILL_MAP: Record<Id, string> = Object.fromEntries(
  Object.entries(SKILL_NODE_MAP).map(([skill, nodeId]) => [nodeId, skill]),
);

/**
 * Minimum persona attempts before a persona counts as the rep's "worst" — guards
 * against a 0/1 sample dominating a real 1/6 weakness. Falls back to any attempted
 * persona when none clear the bar.
 */
const MIN_PERSONA_ATTEMPTS = 3;

const pct = (x: number): number => Math.round(x * 100);
const label = (skill: string): string => skill.replace(/-/g, " ");
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Metric-appropriate phrasing — high hesitation is bad; low conf/enthusiasm is bad. */
function metricMoment(metric: PracticeTarget["metric"]): string {
  if (metric === "hesitation") return "hesitation spiked";
  if (metric === "confidence") return "confidence dropped";
  return "enthusiasm dipped";
}

/** fails / attempts for a node's historical stats (0 when never attempted). */
function nodeFailRate(stats: SalespersonStats, nodeId: Id): number {
  const n = stats.nodes[nodeId];
  if (!n || n.attempts === 0) return 0;
  return n.fails / n.attempts;
}

/**
 * The persona this rep performs WORST against — lowest win rate among personas
 * with a meaningful sample. Ties break toward more attempts (more evidence), then
 * more losses. Returns null when the rep has no attempted personas.
 */
export function weakestPersona(
  stats: SalespersonStats,
): { personaId: Id; attempts: number; wins: number; winRate: number } | null {
  const entries = Object.entries(stats.personas).filter(([, p]) => p.attempts > 0);
  if (entries.length === 0) return null;

  const meaningful = entries.filter(([, p]) => p.attempts >= MIN_PERSONA_ATTEMPTS);
  const pool = meaningful.length > 0 ? meaningful : entries;

  let worst: { personaId: Id; attempts: number; wins: number; winRate: number } | null = null;
  for (const [personaId, p] of pool) {
    const winRate = p.wins / p.attempts;
    const cand = { personaId, attempts: p.attempts, wins: p.wins, winRate };
    if (
      !worst ||
      cand.winRate < worst.winRate ||
      (cand.winRate === worst.winRate && cand.attempts > worst.attempts) ||
      (cand.winRate === worst.winRate &&
        cand.attempts === worst.attempts &&
        p.attempts - p.wins > worst.attempts - worst.wins)
    ) {
      worst = cand;
    }
  }
  return worst;
}

/** GET /salespeople — the rep list with a short career summary for the picker. */
export function listSalespeople(): SalespersonListItem[] {
  return store.salespeople.map((sp) => {
    const stats = getStats(sp.id);
    return {
      id: sp.id,
      name: sp.name,
      totalCalls: stats.totalCalls,
      winRate: overallWinRate(stats),
    };
  });
}

/**
 * The representative call for a rep: their most recent call. sp_jane is pinned to
 * call_showcase (the curated showcase line). Returns null when the rep has no calls.
 */
function representativeCall(salespersonId: Id): { callId: Id; treeId: Id } | null {
  if (salespersonId === "sp_jane") {
    const showcase = store.calls.find((c) => c.id === "call_showcase");
    if (showcase) return { callId: showcase.id, treeId: showcase.treeId };
  }
  const mine = store.calls
    .filter((c) => c.salespersonId === salespersonId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const pick = mine[0];
  return pick ? { callId: pick.id, treeId: pick.treeId } : null;
}

/**
 * Build the "perfect practice call" recommendation for one rep (System 1).
 * Deterministic; every reason references a real baseline stat. Returns null only
 * when the rep id is unknown.
 */
export function buildRecommendedPractice(
  salespersonId: Id,
): RecommendedPractice | null {
  const sp = store.salespeople.find((s) => s.id === salespersonId);
  if (!sp) return null;

  const stats = getStats(salespersonId);
  const rep = representativeCall(salespersonId);
  const tree = rep ? getTree(rep.treeId) : undefined;

  // Persona — worst win rate (with the min-sample guard). Fall back to Skeptical
  // Steve so the demo always has a challenging buyer to drill against.
  const worstPersona = weakestPersona(stats);
  const personaId = worstPersona?.personaId ?? "buy_steve";
  const personaName = getPersona(personaId)?.name ?? personaId;

  // Weakest skill → start node. Fall back to objection-handling / n_incumbent.
  const weakSkill = weakestSkill(stats);
  const skill = weakSkill?.skill ?? "objection-handling";
  const startNodeId = SKILL_NODE_MAP[skill] ?? "n_incumbent";
  const startNodeTitle =
    (tree && getNodeById(tree, startNodeId)?.title) ?? "Incumbent Objection";

  // Reasons — grounded in real numbers.
  const reasons: string[] = [];
  if (worstPersona && worstPersona.attempts > 0) {
    const losses = worstPersona.attempts - worstPersona.wins;
    reasons.push(
      `You lose ${losses} of ${worstPersona.attempts} calls to ${personaName} (${pct(
        worstPersona.winRate,
      )}% win rate).`,
    );
  } else {
    reasons.push(`${personaName} is the toughest buyer to practice against.`);
  }

  if (weakSkill) {
    reasons.push(
      `${cap(label(weakSkill.skill))} is your weakest skill at ${pct(
        weakSkill.failRate,
      )}% miss.`,
    );
  }

  const histNodeFail = nodeFailRate(stats, startNodeId);
  if (histNodeFail > 0) {
    reasons.push(
      `You mishandle the ${startNodeTitle} ${pct(histNodeFail)}% of the time historically.`,
    );
  } else {
    reasons.push(`${startNodeTitle} is where that skill gets tested.`);
  }

  return {
    salespersonId,
    salespersonName: sp.name,
    callId: rep?.callId ?? "",
    treeId: rep?.treeId ?? "",
    startNodeId,
    startNodeTitle,
    personaId,
    personaName,
    headline: `Drill ${startNodeTitle} against ${personaName}`,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// System 2 — blend in-call signal with historical stats to rank practice targets
// ---------------------------------------------------------------------------

/** Composite signal score (from getWeakNodes) normalized to 0..1 (higher = weaker). */
function normSignal(score: number): number {
  // composite = hesitation - confidence - enthusiasm ∈ [-2, 1]
  return Math.min(1, Math.max(0, (score + 2) / 3));
}

interface BlendedTarget extends PracticeTarget {
  /** Internal: components used to build the stats-aware reason. */
  _signal: number;
  _histFail: number;
  _metric: PracticeTarget["metric"];
  _title: string;
}

/**
 * Rank practice targets for a recording by blending in-call signal weakness with
 * the rep's historical stats, and pick the single top "start practicing here" node.
 *
 * `stats` is optional — when absent (rep/call unresolved) the blend degrades to
 * pure in-call signal so the endpoint still produces sensible targets.
 */
export function rankPracticeTargets(
  tree: Tree,
  stats: SalespersonStats | null,
  opts?: { limit?: number },
): { targets: PracticeTarget[]; recommendedStart?: { nodeId: Id; reason: string } } {
  const weakSkill = stats ? weakestSkill(stats) : null;

  const blended: BlendedTarget[] = getWeakNodes(tree).map((wn) => {
    const signal = normSignal(wn.score);
    const histFail = stats ? nodeFailRate(stats, wn.node.id) : 0;
    const mappedSkill = NODE_SKILL_MAP[wn.node.id];
    const skillSignal =
      stats && mappedSkill ? skillFailRate(stats, mappedSkill) : 0;

    // Weight: in-call signal leads, history meaningfully nudges, skill mapping breaks ties.
    const blendScore = 0.5 * signal + 0.35 * histFail + 0.15 * skillSignal;

    return {
      nodeId: wn.node.id,
      reason: buildTargetReason(wn.node.title, wn.worstMetric, histFail, mappedSkill, skillSignal),
      drill: `Practice handling "${wn.node.description}" with stronger ${wn.worstMetric}.`,
      metric: wn.worstMetric,
      score: Math.round(blendScore * 1000) / 1000,
      _signal: signal,
      _histFail: histFail,
      _metric: wn.worstMetric,
      _title: wn.node.title,
    };
  });

  blended.sort((a, b) => b.score - a.score);

  const top = blended[0];
  const recommendedStart = top
    ? {
        nodeId: top.nodeId,
        reason: buildStartReason(top, weakSkill),
      }
    : undefined;

  const limit = opts?.limit ?? 3;
  const targets: PracticeTarget[] = blended.slice(0, limit).map((t) => ({
    nodeId: t.nodeId,
    reason: t.reason,
    drill: t.drill,
    metric: t.metric,
    score: t.score,
  }));

  return { targets, recommendedStart };
}

/** Per-target reason that cites the in-call metric AND history where available. */
function buildTargetReason(
  title: string,
  metric: PracticeTarget["metric"],
  histFail: number,
  mappedSkill: string | undefined,
  skillSignal: number,
): string {
  const base = `${cap(metricMoment(metric))} at the ${title} in this call`;
  if (histFail > 0) {
    return `${base} — and you miss that node ${pct(histFail)}% of the time historically.`;
  }
  if (mappedSkill && skillSignal >= 0.4) {
    return `${base} — it's tied to your ${label(mappedSkill)} weakness (${pct(
      skillSignal,
    )}% miss).`;
  }
  return `${base}.`;
}

/** Top-pick reason — explicitly blends in-call signal with the rep's history. */
function buildStartReason(
  top: BlendedTarget,
  weakSkill: { skill: string; failRate: number } | null,
): string {
  const lead = `Your ${metricMoment(top._metric)} at the ${top._title} in this call`;
  if (top._histFail > 0) {
    return `${lead}, and you miss that node ${pct(
      top._histFail,
    )}% of the time historically — start here.`;
  }
  const mappedSkill = NODE_SKILL_MAP[top.nodeId];
  if (weakSkill && mappedSkill === weakSkill.skill) {
    return `${lead}, and ${label(weakSkill.skill)} is your weakest skill at ${pct(
      weakSkill.failRate,
    )}% miss — start here.`;
  }
  return `${lead} — start here.`;
}
