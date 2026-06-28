// salesperson-stats.ts — per-rep historical performance store.
//
// Mirrors store.ts: a JSON file (data/salesperson-stats.json) is read at startup
// into an in-memory object and written back on every mutation, so the "vs how
// you usually do" comparison survives restarts and updates after each mock call.
//
// One record per salesperson id. Skills use a fixed taxonomy; personas are keyed
// by persona id (buy_polly, …); nodes are keyed by seed tree-node id.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { store } from "./store.js";
import type { Id } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const statsPath = join(__dirname, "data", "salesperson-stats.json");

/** Fixed skill taxonomy the analysis LLM tags each call against. */
export const SKILL_TAXONOMY = [
  "discovery",
  "objection-handling",
  "pricing",
  "closing",
  "rapport",
] as const;
export type Skill = (typeof SKILL_TAXONOMY)[number];

export interface SkillStat {
  attempts: number;
  fails: number;
}
export interface PersonaStat {
  attempts: number;
  wins: number;
  fails: number;
}
export interface NodeStat {
  attempts: number;
  fails: number;
}

export interface SalespersonStats {
  salespersonId: Id;
  totalCalls: number;
  wins: number; // overall closes
  skills: Record<string, SkillStat>;
  personas: Record<string, PersonaStat>;
  nodes: Record<string, NodeStat>;
}

type StatsFile = Record<Id, SalespersonStats>;

/** A single skill verdict for one call, as produced by the analysis LLM. */
export interface SkillTag {
  category: string;
  passed: boolean;
}

function zeroed(salespersonId: Id): SalespersonStats {
  return {
    salespersonId,
    totalCalls: 0,
    wins: 0,
    skills: {},
    personas: {},
    nodes: {},
  };
}

// Load the file at startup (mirror store.ts). Missing file → empty store.
const data: StatsFile = existsSync(statsPath)
  ? (JSON.parse(readFileSync(statsPath, "utf-8")) as StatsFile)
  : {};

// Ensure every known salesperson has at least a zeroed baseline so the very
// first call against a new rep still has a record to read/update.
for (const sp of store.salespeople) {
  if (!data[sp.id]) data[sp.id] = zeroed(sp.id);
}

/** Write the in-memory stats back to disk immediately. */
export function persistStats(): void {
  writeFileSync(statsPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Return the stats record for a salesperson, creating (and persisting) a zeroed
 * one when none exists.
 */
export function getStats(salespersonId: Id): SalespersonStats {
  if (!data[salespersonId]) {
    data[salespersonId] = zeroed(salespersonId);
    persistStats();
  }
  return data[salespersonId];
}

/** fails / attempts for a skill (0 when never attempted). */
export function skillFailRate(stats: SalespersonStats, skill: string): number {
  const s = stats.skills[skill];
  if (!s || s.attempts === 0) return 0;
  return s.fails / s.attempts;
}

/** wins / totalCalls (0 when no calls). */
export function overallWinRate(stats: SalespersonStats): number {
  if (stats.totalCalls === 0) return 0;
  return stats.wins / stats.totalCalls;
}

/** The attempted skill with the highest fail rate — the rep's weakest skill. */
export function weakestSkill(
  stats: SalespersonStats,
): { skill: string; failRate: number } | null {
  let worst: { skill: string; failRate: number } | null = null;
  for (const skill of SKILL_TAXONOMY) {
    const s = stats.skills[skill];
    if (!s || s.attempts === 0) continue;
    const failRate = s.fails / s.attempts;
    if (!worst || failRate > worst.failRate) worst = { skill, failRate };
  }
  return worst;
}

const pct = (x: number): number => Math.round(x * 100);
const label = (skill: string): string => skill.replace(/-/g, " ");
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A compact, human-readable summary of the rep's current stats — fed to the
 * analysis LLM as context so it can calibrate strengths/weaknesses.
 */
export function summarizeStats(stats: SalespersonStats): string {
  const lines: string[] = [];
  lines.push(
    `Career: ${stats.totalCalls} calls, ${stats.wins} wins (${pct(
      overallWinRate(stats),
    )}% win rate).`,
  );
  const skillBits = SKILL_TAXONOMY.filter((s) => stats.skills[s]?.attempts).map(
    (s) => `${label(s)} ${pct(skillFailRate(stats, s))}% miss`,
  );
  if (skillBits.length) lines.push(`Skill miss rates: ${skillBits.join(", ")}.`);
  const personaBits = Object.entries(stats.personas)
    .filter(([, p]) => p.attempts > 0)
    .map(([id, p]) => `${id} ${p.wins}/${p.attempts} won`);
  if (personaBits.length) lines.push(`By persona: ${personaBits.join(", ")}.`);
  return lines.join("\n");
}

/**
 * Build the single "vs how you usually do" comparison line deterministically
 * from the BASELINE stats (read before this call is applied) and the call's
 * skill verdicts. Always references real baseline numbers.
 */
export function buildComparisonLine(
  baseline: SalespersonStats,
  skillTags: SkillTag[],
): string {
  const weak = weakestSkill(baseline);

  // 1) Beat a historically weak skill this call → celebrate the improvement.
  const improved = skillTags.find(
    (t) => t.passed && skillFailRate(baseline, t.category) >= 0.4,
  );
  if (improved) {
    return `You handled ${label(improved.category)} better than your usual ${pct(
      skillFailRate(baseline, improved.category),
    )}% miss rate.`;
  }

  // 2) Missed your weakest skill again → name it.
  const slippedWeakest = skillTags.find(
    (t) => !t.passed && weak && t.category === weak.skill,
  );
  if (slippedWeakest && weak) {
    return `${cap(label(weak.skill))} slipped again — still your weakest skill at ${pct(
      weak.failRate,
    )}% miss.`;
  }

  // 3) Missed some other historically shaky skill.
  const shakyFail = skillTags.find(
    (t) => !t.passed && skillFailRate(baseline, t.category) >= 0.4,
  );
  if (shakyFail) {
    return `${cap(label(shakyFail.category))} stayed shaky — you miss it ${pct(
      skillFailRate(baseline, shakyFail.category),
    )}% of the time.`;
  }

  // 4) Held a historically strong skill.
  const heldStrong = skillTags.find(
    (t) =>
      t.passed &&
      baseline.skills[t.category]?.attempts &&
      skillFailRate(baseline, t.category) <= 0.25,
  );
  if (heldStrong) {
    return `Solid ${label(heldStrong.category)} again — right in line with your ${
      100 - pct(skillFailRate(baseline, heldStrong.category))
    }% hit rate there.`;
  }

  // 5) Nothing comparable surfaced → anchor on the career win rate.
  return `One more rep on top of your ${pct(overallWinRate(baseline))}% career win rate (${baseline.wins}/${baseline.totalCalls}).`;
}

/**
 * Apply one finished mock call to a rep's stats and persist.
 *   - totalCalls += 1; wins += 1 when outcome === "won"
 *   - per-skill attempts/fails from skillTags
 *   - per-persona attempts/wins/fails from personaId + outcome
 *   - per-node fails from nodeFails (seed node ids the rep mishandled)
 */
export function applyCall(
  salespersonId: Id,
  args: {
    outcome: "won" | "lost" | "open";
    personaId: Id;
    skillTags: SkillTag[];
    nodeFails?: string[];
  },
): SalespersonStats {
  const stats = getStats(salespersonId);

  stats.totalCalls += 1;
  if (args.outcome === "won") stats.wins += 1;

  for (const tag of args.skillTags) {
    const s = (stats.skills[tag.category] ??= { attempts: 0, fails: 0 });
    s.attempts += 1;
    if (!tag.passed) s.fails += 1;
  }

  const p = (stats.personas[args.personaId] ??= {
    attempts: 0,
    wins: 0,
    fails: 0,
  });
  p.attempts += 1;
  if (args.outcome === "won") p.wins += 1;
  else if (args.outcome === "lost") p.fails += 1;

  for (const nodeId of args.nodeFails ?? []) {
    const n = (stats.nodes[nodeId] ??= { attempts: 0, fails: 0 });
    n.attempts += 1;
    n.fails += 1;
  }

  persistStats();
  return stats;
}
