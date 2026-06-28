// Store backed by seed.json. Mutations are written back to disk immediately
// so state survives server restarts.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  Call,
  CallSummary,
  Id,
  Recording,
  SeedStore,
  Tree,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, "data", "seed.json");

export const DEAL_VALUE = 45000;

export const store: SeedStore = JSON.parse(readFileSync(seedPath, "utf-8")) as SeedStore;

// expectedValue = round(successProbability * dealValue)  (contract §1)
export const expectedValue = (p: number): number => Math.round(p * DEAL_VALUE);

/** Write the current in-memory store back to seed.json immediately. */
export function persist(): void {
  writeFileSync(seedPath, JSON.stringify(store, null, 2), "utf-8");
}

/** Upsert a recording into the store (does NOT call persist). */
export function putRecording(rec: Recording): void {
  store.recordings[rec.id] = rec;
}

/** Upsert a tree into the store (does NOT call persist). */
export function putTree(tree: Tree): void {
  store.trees[tree.id] = tree;
}

/** Append a call to the store (does NOT call persist). */
export function putCall(call: Call): void {
  store.calls.push(call);
}

/**
 * Generate a stable, human-readable id.
 * Format: `<prefix>_<base36-timestamp>_<4-char-random>`
 * Example: rec_lhz3k2_a3f1
 */
export function newId(prefix: string): Id {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}_${rand}`;
}

export const getCall = (id: Id): Call | undefined =>
  store.calls.find((c) => c.id === id);

export const getTree = (id: Id): Tree | undefined => store.trees[id];

export const getRecording = (id: Id): Recording | undefined =>
  store.recordings[id];

export const recordingsForCall = (callId: Id): Recording[] =>
  Object.values(store.recordings).filter((r) => r.callId === callId);

export const getCompany = (companyId: Id) =>
  store.companies.find((c) => c.id === companyId);

export const companyName = (companyId: Id): string =>
  getCompany(companyId)?.name ?? "Unknown";

export const getBuyer = (buyerId: Id): { name: string; title: string; personaId?: Id } => {
  for (const c of store.companies) {
    const b = c.buyers.find((x) => x.id === buyerId);
    if (b) return { name: b.name, title: b.title, personaId: b.personaId };
  }
  return { name: "Unknown", title: "" };
};

const getSalespersonName = (salespersonId: Id): string =>
  store.salespeople.find((s) => s.id === salespersonId)?.name ?? "Unknown";

// Deterministic per-call downward jitter (0–8%) on the realized EV. Calls of the
// same archetype land on the same leaf and would otherwise show an identical
// figure; this varies the displayed dollars without crossing an evaluation grade
// boundary. Rounded to the nearest $50.
function jitterEV(baseEV: number, callId: Id): number {
  let h = 0;
  for (let i = 0; i < callId.length; i++) h = (h * 31 + callId.charCodeAt(i)) >>> 0;
  const downPct = (h % 9) / 100; // 0.00 .. 0.08
  return Math.round((baseEV * (1 - downPct)) / 50) * 50;
}

// Derive outcome from the real recording's final node, bestEV from max node EV.
// Outcome thresholds: won >= 0.8, lost <= 0.1, open in between.
export function toCallSummary(call: Call): CallSummary {
  const tree = getTree(call.treeId);
  const real = recordingsForCall(call.id).find((r) => r.isReal);

  let outcome: CallSummary["outcome"] = "open";
  // finalEV — the EV at the node the real call actually ended on (realized value).
  // Distinct per call even though all calls share one tree, so it differentiates them.
  let finalEV = 0;
  if (real) {
    const finalNode = tree?.nodes.find(
      (n) => n.id === real.traversal.finalNodeId,
    );
    if (finalNode) {
      finalEV = jitterEV(finalNode.expectedValue, call.id);
      if (!real.isActive) {
        if (finalNode.successProbability >= 0.8) outcome = "won";
        else if (finalNode.successProbability <= 0.1) outcome = "lost";
      }
    }
  }

  const bestEV = tree
    ? Math.max(0, ...tree.nodes.map((n) => n.expectedValue))
    : 0;

  const company = getCompany(call.companyId);

  return {
    id: call.id,
    company: company?.name ?? "Unknown",
    industry: company?.industry,
    seats: company?.seats,
    incumbent: company?.incumbent,
    startedAt: call.startedAt,
    outcome,
    bestEV,
    finalEV,
    buyer: getBuyer(call.buyerId),
    salesperson: { id: call.salespersonId, name: getSalespersonName(call.salespersonId) },
  };
}
