// Store backed by seed.json. Mutations are written back to disk immediately
// so state survives server restarts.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  Buyer,
  Call,
  CallSummary,
  Company,
  Id,
  Recording,
  Salesperson,
  SeedStore,
  Tree,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, "data", "seed.json");

export const DEAL_VALUE = 48000;

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

export const getCompany = (companyId: Id): Company | undefined =>
  store.companies.find((c) => c.id === companyId);

export const companyName = (companyId: Id): string =>
  getCompany(companyId)?.name ?? "Unknown";

export const getBuyer = (buyerId: Id): Buyer | undefined => {
  for (const company of store.companies) {
    const buyer = company.buyers.find((b) => b.id === buyerId);
    if (buyer) return buyer;
  }
  return undefined;
};

export const getSalesperson = (id: Id): Salesperson | undefined =>
  store.salespeople.find((s) => s.id === id);

// Derive outcome from the real recording's final node, bestEV from max node EV.
// Outcome thresholds: won >= 0.8, lost <= 0.1, open in between.
export function toCallSummary(call: Call): CallSummary {
  const tree = getTree(call.treeId);
  const real = recordingsForCall(call.id).find((r) => r.isReal);

  let outcome: CallSummary["outcome"] = "open";
  if (real && !real.isActive) {
    const finalNode = tree?.nodes.find(
      (n) => n.id === real.traversal.finalNodeId,
    );
    if (finalNode) {
      if (finalNode.successProbability >= 0.8) outcome = "won";
      else if (finalNode.successProbability <= 0.1) outcome = "lost";
    }
  }

  const bestEV = tree
    ? Math.max(0, ...tree.nodes.map((n) => n.expectedValue))
    : 0;

  return {
    id: call.id,
    company: companyName(call.companyId),
    startedAt: call.startedAt,
    outcome,
    bestEV,
  };
}
