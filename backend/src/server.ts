// CallTree backend — single Express process serving the API contract.
//
// Phase 1 (A) — read endpoints serve real seed data.
// Phase 2 (B) — recording lifecycle endpoints are fully implemented.
// Phase 3+ (C) — realtime/agent endpoints remain contract-shaped stubs.

import cors from "cors";
import express, { type Request, type Response } from "express";
import {
  getCall,
  getRecording,
  getTree,
  newId,
  persist,
  putCall,
  putRecording,
  putTree,
  recordingsForCall,
  store,
  toCallSummary,
} from "./store.js";
import {
  buildWalkthroughTimeline,
  getWeakNodes,
  insertBranchNode,
  matchOrCreateBranch,
  routeTranscriptToNode,
} from "./tree-ops.js";
import type {
  AiFeedback,
  AiNotes,
  Call,
  CallDetail,
  CallSummary,
  CreateCallReq,
  MockTurnReq,
  PracticeTarget,
  Recording,
  TraversalStep,
  Tree,
  TreeNode,
  WalkthroughBundle,
} from "./types.js";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Serve generated/seed audio from /data/audio (referenced by audioPath/audioUrl).
app.use("/data", express.static(new URL("../public/data", import.meta.url).pathname));

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

const notFound = (res: Response, message: string) =>
  fail(res, 404, "not_found", message);

// ---------------------------------------------------------------------------
// A · Browse & read  (real seed data)
// ---------------------------------------------------------------------------

// 1. GET /calls?last=N&scope=me|team&companyId=  → CallSummary[]
app.get("/calls", (req: Request, res: Response) => {
  const { last, companyId } = req.query;
  let calls = [...store.calls];
  if (typeof companyId === "string") {
    calls = calls.filter((c) => c.companyId === companyId);
  }
  // scope=me|team is a single-user hackathon; both resolve to all calls.
  let summaries: CallSummary[] = calls
    .map(toCallSummary)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (typeof last === "string" && Number.isFinite(Number(last))) {
    summaries = summaries.slice(0, Number(last));
  }
  res.json(summaries);
});

// 2. GET /calls/:id  → CallDetail
app.get("/calls/:id", (req: Request, res: Response) => {
  const call = getCall(req.params.id);
  if (!call) return notFound(res, `call ${req.params.id} not found`);
  const tree = getTree(call.treeId);
  if (!tree) return notFound(res, `tree ${call.treeId} not found`);
  const detail: CallDetail = {
    call,
    tree,
    recordings: recordingsForCall(call.id),
  };
  res.json(detail);
});

// 3. GET /trees/:id  → Tree
app.get("/trees/:id", (req: Request, res: Response) => {
  const tree = getTree(req.params.id);
  if (!tree) return notFound(res, `tree ${req.params.id} not found`);
  res.json(tree);
});

// 4. GET /recordings/:id  → Recording
app.get("/recordings/:id", (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);
  res.json(rec);
});

// ---------------------------------------------------------------------------
// B · Recording lifecycle  (fully implemented — Phase 2)
// ---------------------------------------------------------------------------

// 5. POST /calls (CreateCallReq) → { callId, treeId, recordingId }
app.post("/calls", (req: Request<{}, {}, CreateCallReq>, res: Response) => {
  const { companyId, salespersonId, buyerId, startedAt, audioPath } = req.body ?? {};
  if (!companyId || !salespersonId || !buyerId || !startedAt) {
    return fail(res, 400, "bad_input", "companyId, salespersonId, buyerId, startedAt required");
  }

  const callId = newId("call");
  const treeId = newId("tree");
  const recordingId = newId("rec");
  const rootNodeId = newId("n");

  // Create a minimal root TreeNode
  const rootNode: TreeNode = {
    id: rootNodeId,
    parentId: null,
    childIds: [],
    title: "Opening",
    description: "Start of call",
    speaker: "seller",
    tMs: 0,
    successProbability: 0.5,
    expectedValue: Math.round(0.5 * 48000),
    metrics: { confidence: 0.5, hesitation: 0.3, enthusiasm: 0.5 },
  };

  const tree: Tree = {
    id: treeId,
    callId,
    rootNodeId,
    nodes: [rootNode],
  };

  const call: Call = {
    id: callId,
    companyId,
    salespersonId,
    buyerId,
    startedAt,
    treeId,
    recordingIds: [recordingId],
  };

  const rec: Recording = {
    id: recordingId,
    callId,
    treeId,
    isReal: true,
    isActive: true,
    startNodeId: null,
    stopNodeId: null,
    audioPath: audioPath ?? "",
    lengthMs: 0,
    transcript: [],
    traversal: {
      initialNodeId: rootNodeId,
      finalNodeId: rootNodeId,
      steps: [],
    },
    aiNotes: null,
    aiFeedback: null,
  };

  putTree(tree);
  putCall(call);
  putRecording(rec);
  persist();

  res.json({ callId, treeId, recordingId });
});

// 6. POST /recordings (StartRecordingReq) → { recordingId }
app.post("/recordings", (req: Request, res: Response) => {
  const { callId, isReal, startNodeId, stopNodeId } = req.body ?? {};
  if (!callId) return fail(res, 400, "bad_input", "callId required");

  const call = getCall(callId);
  if (!call) return notFound(res, `call ${callId} not found`);

  const tree = getTree(call.treeId);
  if (!tree) return notFound(res, `tree ${call.treeId} not found`);

  const initialNodeId: string = startNodeId ?? tree.rootNodeId;

  const recordingId = newId("rec");
  const rec: Recording = {
    id: recordingId,
    callId,
    treeId: call.treeId,
    isReal: isReal ?? false,
    isActive: true,
    startNodeId: startNodeId ?? null,
    stopNodeId: stopNodeId ?? null,
    audioPath: "",
    lengthMs: 0,
    transcript: [],
    traversal: {
      initialNodeId,
      finalNodeId: initialNodeId,
      steps: [],
    },
    aiNotes: null,
    aiFeedback: null,
  };

  putRecording(rec);
  call.recordingIds.push(recordingId);
  persist();

  res.status(201).json({ recordingId });
});

// 7. PATCH /recordings/:id (AppendReq) → 202 { ok, currentNodeId }
app.patch("/recordings/:id", (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);

  const { segments, steps } = req.body ?? {};
  if (!Array.isArray(segments) || segments.length === 0) {
    return fail(res, 400, "bad_input", "segments array required");
  }

  const tree = getTree(rec.treeId);
  if (!tree) return notFound(res, `tree ${rec.treeId} not found`);

  // Append transcript segments
  rec.transcript.push(...segments);

  if (Array.isArray(steps) && steps.length > 0) {
    // Caller supplied explicit traversal steps — use them directly
    rec.traversal.steps.push(...steps);
    rec.traversal.finalNodeId = steps[steps.length - 1].toNodeId;
  } else {
    // Run the tree engine to derive traversal steps from new segments
    let currentNodeId = rec.traversal.finalNodeId;
    for (const seg of segments) {
      const result = routeTranscriptToNode(tree, currentNodeId, seg);
      if (result.matched) {
        const step: TraversalStep = {
          transcriptIndex: seg.index,
          fromNodeId: currentNodeId,
          toNodeId: result.toNodeId,
          tMs: seg.tStartMs,
        };
        rec.traversal.steps.push(step);
        currentNodeId = result.toNodeId;
      }
    }
    rec.traversal.finalNodeId = currentNodeId;
  }

  // Update lengthMs to the end of the last segment
  rec.lengthMs = segments[segments.length - 1].tEndMs ?? rec.lengthMs;

  putRecording(rec);
  persist();

  res.status(202).json({ ok: true, currentNodeId: rec.traversal.finalNodeId });
});

// 8. POST /recordings/:id/feedback → AiFeedback
app.post("/recordings/:id/feedback", (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);

  // Return cached feedback immediately if it already exists (covers rec_real from seed)
  if (rec.aiFeedback) {
    return res.json(rec.aiFeedback);
  }

  const tree = getTree(rec.treeId);
  if (!tree) return notFound(res, `tree ${rec.treeId} not found`);

  // Generate deterministic feedback from weak nodes
  const weakNodes = getWeakNodes(tree, { limit: 3 });

  const practiceTargets: PracticeTarget[] = weakNodes.map((wn) => ({
    nodeId: wn.node.id,
    reason: `Low ${wn.worstMetric} detected at "${wn.node.title}"`,
    drill: `Practice handling "${wn.node.description}" with stronger ${wn.worstMetric}.`,
    metric: wn.worstMetric,
    score: wn.score,
  }));

  const feedback: AiFeedback = {
    summary: `Call reviewed. ${weakNodes.length} node(s) flagged for practice based on signal metrics.`,
    strengths: ["Structured opening", "Clear discovery questions"],
    weaknesses: weakNodes.map((wn) => `Weak ${wn.worstMetric} at "${wn.node.title}"`),
    practiceTargets,
  };

  rec.aiFeedback = feedback;
  putRecording(rec);
  persist();

  res.json(feedback);
});

// 9. GET /recordings/:id/walkthrough?kind=intro|review → WalkthroughBundle
app.get("/recordings/:id/walkthrough", (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);
  const kind = req.query.kind === "intro" ? "intro" : "review";
  const bundle: WalkthroughBundle = {
    audioUrl: `/data/audio/walkthrough_${rec.id}_${kind}.mp3`,
    timeline: buildWalkthroughTimeline(rec.traversal),
  };
  res.json(bundle);
});

// ---------------------------------------------------------------------------
// C · Realtime & agents  (contract-shaped stubs — Phase 3+)
// ---------------------------------------------------------------------------

// 10. GET /stream/:recordingId (SSE) → LiveEvent stream
app.get("/stream/:recordingId", (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  // TODO(real): drive move/branch/metrics/notes/transcript events from the
  // Tree + Signal engines.
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    res.end();
  });
});

// 11. POST /transcribe (multipart) → { segments }
app.post("/transcribe", (_req: Request, res: Response) => {
  // TODO(real): forward audio to Whisper, offset timestamps by tStartMs,
  // continue index from the recording's transcript length.
  res.json({ segments: [] });
});

// 12. POST /agent/notes (NotesReq) → AiNotes
app.post("/agent/notes", (_req: Request, res: Response) => {
  // TODO(real): LLM extracts commitments/objections/facts/suggestions from the
  // window; merge into recording.aiNotes; emit a notes event.
  const notes: AiNotes = {
    commitments: [],
    objections: ["No Tableau integration"],
    facts: ["Analytics team standardized on Tableau"],
    suggestions: ["Offer SQL connectors as a bridge"],
  };
  res.json(notes);
});

// 13. POST /agent/branch (BranchReq) → { node } | { node:null, matchedNodeId }
app.post("/agent/branch", (req: Request, res: Response) => {
  const { recordingId, currentNodeId, utterance } = req.body ?? {};
  if (!currentNodeId || !utterance) {
    return fail(res, 400, "bad_input", "currentNodeId and utterance required");
  }

  const rec = recordingId ? getRecording(recordingId) : null;
  const treeId = rec?.treeId;
  const tree = treeId ? getTree(treeId) : null;
  if (!tree) return fail(res, 400, "bad_input", "valid recordingId required to resolve tree");

  const decision = matchOrCreateBranch(tree, currentNodeId, utterance);

  if (decision.created) {
    putTree(tree);
    persist();
    res.json({ node: decision.node });
  } else {
    res.json({ node: null, matchedNodeId: decision.matchedNodeId });
  }
});

// 14. POST /mock/turn (MockTurnReq) → { lines, proposedChild? }
app.post("/mock/turn", (req: Request<{}, {}, MockTurnReq>, res: Response) => {
  const { currentNodeId, role } = req.body ?? {};

  const lines: { speaker: "buyer" | "seller"; text: string }[] = [];

  // Node-aware responses for the Tableau practice scenario
  if (currentNodeId === "n_push") {
    if (role === "buyer" || role === "both") {
      lines.push({
        speaker: "buyer",
        text: "You don't have Tableau integration. Our analytics team is fully standardized on it.",
      });
    }
    if (role === "both") {
      lines.push({
        speaker: "seller",
        text: "Totally understand — your team won't need to change anything. Our SQL connectors pipe data directly into Tableau, so you keep your existing workflows.",
      });
    }
    if (role === "seller") {
      lines.push({
        speaker: "seller",
        text: "Great question — our SQL connectors mean you keep Tableau exactly as-is. The data flows through without any migration.",
      });
    }
  } else if (currentNodeId === "n_alt") {
    lines.push({
      speaker: "buyer",
      text: "Oh, so we'd keep Tableau and just pipe data in through your connectors? That actually works for us.",
    });
  } else if (currentNodeId === "n_road") {
    if (role === "buyer" || role === "both") {
      lines.push({
        speaker: "buyer",
        text: "Roadmap doesn't help us right now. Can you send me the deck and we'll revisit later?",
      });
    }
  } else {
    // Generic fallback
    lines.push({
      speaker: role === "seller" ? "seller" : "buyer",
      text: role === "seller"
        ? "Let me walk you through how we typically solve this."
        : "Tell me more about how that would work for our use case.",
    });
  }

  res.json({ lines, proposedChild: null as TreeNode | null });
});

// 15. POST /tts (TtsReq) → { audioUrl }
app.post("/tts", (req: Request, res: Response) => {
  const { text, voiceId } = req.body ?? {};
  if (typeof text !== "string" || typeof voiceId !== "string") {
    return fail(res, 400, "bad_input", "text and voiceId required");
  }
  // TODO(real): proxy to ElevenLabs (key server-side), save under /data/audio,
  // cache by hash(text+voiceId).
  res.json({ audioUrl: "/data/audio/tts_stub.mp3" });
});

// ---------------------------------------------------------------------------

app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "calltree-backend",
    status: "ok",
    phase: "Phase 2 — recording lifecycle live",
  });
});

app.listen(PORT, () => {
  console.log(`CallTree backend listening on http://localhost:${PORT}`);
});
