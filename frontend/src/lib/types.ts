// Mirrored from context/calltree-api-contract.md §2. The contract is canonical —
// if a type changes there, change it here to match. Do not invent fields.

export type Id = string;

export type Outcome = "won" | "lost" | "open";

/** GET /calls → CallSummary[] */
export interface CallSummary {
  id: Id;
  company: string;
  startedAt: string; // ISO 8601
  outcome: Outcome; // kept for internal use; UI shows the evaluation
  bestEV: number; // max node EV in the tree
  finalEV: number; // EV at the node the real call ended on (realized value)
  buyer: { name: string; title: string }; // resolved from the call's buyerId
  salesperson: { name: string }; // resolved from the call's salespersonId
}

/** GET /recordings/:id/walkthrough → WalkthroughBundle */
export interface TimelineCue {
  atMs: number;
  nodeId: Id;
}

export interface WalkthroughSegment {
  nodeId: Id;
  audioUrl: string;
}
export interface WalkthroughBundle {
  audioUrl: string; // single concatenated render (fallback playback)
  timeline: TimelineCue[]; // cue offsets into audioUrl (fallback sync)
  segments?: WalkthroughSegment[]; // one clip per path node → exact, gapless sync
}

export type Speaker = "seller" | "buyer";

export interface SignalMetrics {
  confidence: number;
  hesitation: number;
  enthusiasm: number;
} // each 0..1

export interface TreeNode {
  id: Id;
  parentId: Id | null;
  childIds: Id[];
  title: string; // "Pushback"
  description: string; // "You don't have Tableau integration"
  speaker: Speaker;
  tMs: number; // offset into the call this moment occurred
  successProbability: number; // 0..1 → green↔red spectrum
  expectedValue: number; // currency
  metrics: SignalMetrics;
  stats?: NodeStats; // optional — observed traversal stats across this call's population
}

export interface NodeStats {
  visits: number;
  wins: number;
  winRate: number; // (wins + 1) / (visits + 2)
}

export interface Tree {
  id: Id;
  callId: Id;
  rootNodeId: Id;
  nodes: TreeNode[];
}

export interface Call {
  id: Id;
  companyId: Id;
  salespersonId: Id;
  buyerId: Id;
  startedAt: string; // ISO 8601
  treeId: Id;
  recordingIds: Id[];
}

export interface TranscriptSegment {
  index: number;
  speaker: Speaker;
  text: string;
  tStartMs: number;
  tEndMs: number;
}

export interface TraversalStep {
  transcriptIndex: number;
  fromNodeId: Id;
  toNodeId: Id;
  tMs: number;
}

export interface Traversal {
  initialNodeId: Id;
  finalNodeId: Id;
  steps: TraversalStep[];
}

export interface AiNotes {
  commitments: string[];
  objections: string[];
  facts: string[];
  suggestions: string[];
}

export interface PracticeTarget {
  nodeId: Id;
  reason: string;
  drill: string;
  metric: keyof SignalMetrics;
  score: number;
}

export interface AiFeedback {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  practiceTargets: PracticeTarget[];
  /** Top "start practicing here" pick (System 2) — cites in-call signal + history. */
  recommendedStart?: { nodeId: Id; reason: string };
}

export interface Recording {
  id: Id;
  callId: Id;
  treeId: Id;
  isReal: boolean; // true = actual call; false = a mock
  isActive: boolean; // currently in progress (live)
  startNodeId: Id | null; // mock: where practice begins (null = root)
  stopNodeId: Id | null; // mock: breakpoint to stop at
  audioPath: string;
  lengthMs: number;
  transcript: TranscriptSegment[];
  traversal: Traversal;
  aiNotes: AiNotes | null; // live intel
  aiFeedback: AiFeedback | null; // post-call review
}

/** GET /calls/:id → CallDetail */
export interface CallDetail {
  call: Call;
  tree: Tree;
  recordings: Recording[];
}

/** GET /personas → PersonaInfo[] — the buyer personas the AI can play. */
export interface PersonaInfo {
  id: Id;
  name: string;
  description: string;
}

/** GET /salespeople → rep list for the practice picker (winRate 0..1). */
export interface SalespersonListItem {
  id: Id;
  name: string;
  totalCalls: number;
  winRate: number;
}

/** GET /salespeople/:id/recommended-practice → the "perfect practice call" (System 1). */
export interface RecommendedPractice {
  salespersonId: Id;
  salespersonName: string;
  callId: Id;
  treeId: Id;
  startNodeId: Id;
  startNodeTitle: string;
  personaId: Id;
  personaName: string;
  headline: string;
  reasons: string[];
}

/** A skill verdict for a single mock call. */
export interface MockSkillTag {
  category: string;
  passed: boolean;
}

/** POST /recordings/:id/mock-analysis → MockCallAnalysis (post-call popup). */
export interface MockCallAnalysis {
  summary: string;
  topStrength: string;
  topWeakness: string;
  comparisonLine: string;
  outcome: Outcome;
  skillTags: MockSkillTag[];
  salespersonName: string;
}
