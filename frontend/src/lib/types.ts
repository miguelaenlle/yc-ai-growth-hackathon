// Mirrored from context/calltree-api-contract.md §2. The contract is canonical —
// if a type changes there, change it here to match. Do not invent fields.

export type Id = string;

export type Outcome = "won" | "lost" | "open";

/** GET /calls → CallSummary[] */
export interface CallSummary {
  id: Id;
  company: string;
  startedAt: string; // ISO 8601
  outcome: Outcome;
  bestEV: number; // best expected value across the tree
  // TODO: buyer/salesperson { name, title } once the contract is extended.
}
