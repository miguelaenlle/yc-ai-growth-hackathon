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
  bestEV: number;
}

/** GET /calls/:id → CallDetail */
export interface Call {
  id: Id;
  companyId: Id;
  salespersonId: Id;
  buyerId: Id;
  startedAt: string;
  treeId: Id;
  recordingIds: Id[];
}

export interface Recording {
  id: Id;
  callId: Id;
  treeId: Id;
  isReal: boolean;
  isActive: boolean;
  startNodeId: Id | null;
  stopNodeId: Id | null;
  audioPath: string;
  lengthMs: number;
}

export interface CallDetail {
  call: Call;
  tree: unknown;
  recordings: Recording[];
}

/** GET /recordings/:id/walkthrough → WalkthroughBundle */
export interface TimelineCue {
  atMs: number;
  nodeId: Id;
}

export interface WalkthroughBundle {
  audioUrl: string;
  timeline: TimelineCue[];
}
