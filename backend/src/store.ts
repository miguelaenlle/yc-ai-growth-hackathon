// In-memory store backed by the seed JSON. Hackathon scope: one process,
// one local JSON file, no persistence to disk on mutation. Mutations during a
// session live in memory only — restart resets to the seed.

import { readFileSync } from "node:fs";
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

export const DEAL_VALUE = 48000;

// Deep-clone the seed so in-memory mutations never corrupt the on-disk source.
const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as SeedStore;

export const store: SeedStore = structuredClone(seed);

// expectedValue = round(successProbability * dealValue)  (contract §1)
export const expectedValue = (p: number): number => Math.round(p * DEAL_VALUE);

export const getCall = (id: Id): Call | undefined =>
  store.calls.find((c) => c.id === id);

export const getTree = (id: Id): Tree | undefined => store.trees[id];

export const getRecording = (id: Id): Recording | undefined =>
  store.recordings[id];

export const recordingsForCall = (callId: Id): Recording[] =>
  Object.values(store.recordings).filter((r) => r.callId === callId);

export const companyName = (companyId: Id): string =>
  store.companies.find((c) => c.id === companyId)?.name ?? "Unknown";

// Derive outcome from the real recording's final node, bestEV from max node EV.
export function toCallSummary(call: Call): CallSummary {
  const tree = getTree(call.treeId);
  const real = recordingsForCall(call.id).find((r) => r.isReal);

  let outcome: CallSummary["outcome"] = "open";
  if (real && !real.isActive) {
    const finalNode = tree?.nodes.find(
      (n) => n.id === real.traversal.finalNodeId,
    );
    if (finalNode) outcome = finalNode.successProbability >= 0.5 ? "won" : "lost";
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
