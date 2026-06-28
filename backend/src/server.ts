// CallTree backend — single Express process serving the API contract.
//
// SCAFFOLD STATUS: read endpoints (A) serve the real seed data. The recording
// lifecycle, realtime, and agent endpoints (B/C) return contract-shaped DUMMY
// responses so the frontend can build against real shapes. Each stub is marked
// with `// TODO(real)` where live logic (LLM / STT / Tree Engine) goes.

import cors from "cors";
import express, { type Request, type Response } from "express";
import expressWs from "express-ws";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCall,
  getRecording,
  getTree,
  recordingsForCall,
  store,
  toCallSummary,
} from "./store.js";
import type {
  AiFeedback,
  AiNotes,
  CallDetail,
  CallSummary,
  CreateCallReq,
  TreeNode,
} from "./types.js";
import { handleMockSession } from "./mock.js";
import { getOrBuildWalkthrough } from "./walkthrough.js";

const { app } = expressWs(express());
const PORT = 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());

// Serve generated/seed audio from /data/audio (referenced by audioPath/audioUrl).
app.use("/data", express.static(join(__dirname, "../public/data")));

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
// B · Recording lifecycle  (dummy responses, contract shapes)
// ---------------------------------------------------------------------------

let idCounter = 0;
const newId = (prefix: string) => `${prefix}_${(++idCounter).toString(36)}stub`;

// 5. POST /calls (CreateCallReq) → { callId, treeId, recordingId }
app.post("/calls", (req: Request<{}, {}, CreateCallReq>, res: Response) => {
  const { companyId, salespersonId, buyerId, startedAt } = req.body ?? {};
  if (!companyId || !salespersonId || !buyerId || !startedAt) {
    return fail(res, 400, "bad_input", "companyId, salespersonId, buyerId, startedAt required");
  }
  const callId = newId("call");
  const treeId = newId("tree");
  const recordingId = newId("rec");
  // TODO(real): persist Call + empty Tree (one root node) + active real Recording,
  // then kick off async processing. For now we only echo the ids.
  res.json({ callId, treeId, recordingId });
});

// 6. POST /recordings (StartRecordingReq) → { recordingId }
app.post("/recordings", (req: Request, res: Response) => {
  const { callId } = req.body ?? {};
  if (!callId) return fail(res, 400, "bad_input", "callId required");
  // TODO(real): create recording on the call's tree, isActive:true,
  // traversal.initialNodeId = startNodeId ?? rootNodeId, store stopNodeId.
  res.json({ recordingId: newId("rec") });
});

// 7. PATCH /recordings/:id (AppendReq) → 202 { ok, currentNodeId }
app.patch("/recordings/:id", (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);
  // TODO(real): append segments, run Tree Engine to derive steps, run Signal
  // Engine to write node metrics, emit LiveEvents, persist.
  res.status(202).json({ ok: true, currentNodeId: rec.traversal.finalNodeId });
});

// 8. POST /recordings/:id/feedback → AiFeedback
app.post("/recordings/:id/feedback", (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);
  // TODO(real): build review from transcript + node metrics (LLM); scan path
  // for weak nodes and emit ranked PracticeTargets. For now echo the seeded
  // feedback if present, else a contract-shaped stub.
  const feedback: AiFeedback =
    rec.aiFeedback ?? {
      summary: "Stub feedback — wire up the LLM review engine.",
      strengths: [],
      weaknesses: [],
      practiceTargets: [],
    };
  res.json(feedback);
});

// 9. GET /recordings/:id/walkthrough?kind=intro|review → WalkthroughBundle
app.get("/recordings/:id/walkthrough", async (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);
  const kind = req.query.kind === "intro" ? "intro" : "review";
  try {
    const bundle = await getOrBuildWalkthrough(rec, kind);
    res.json(bundle);
  } catch (e) {
    console.error("Walkthrough error:", e);
    fail(res, 500, "walkthrough_failed", e instanceof Error ? e.message : "Walkthrough generation failed");
  }
});

// ---------------------------------------------------------------------------
// C · Realtime & agents  (dummy responses, contract shapes)
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
  // Tree + Signal engines. For now just a heartbeat so the client can connect.
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
  const { currentNodeId } = req.body ?? {};
  if (!currentNodeId) return fail(res, 400, "bad_input", "currentNodeId required");
  // TODO(real): score utterance vs existing decision nodes (embedding / LLM).
  // Above threshold → matchedNodeId, create nothing. Below → one new node.
  // Stub matches the current node so the tree never grows on rephrasings.
  res.json({ node: null, matchedNodeId: currentNodeId });
});

// 14. WS /mock/session/:recordingId (Websocket) → Audio Stream
app.ws("/mock/session/:recordingId", (ws, req) => {
  const { recordingId } = req.params;
  const currentNodeId = req.query.currentNodeId as string;
  const includePrecap = req.query.includePrecap === "true";
  const maxDepth = req.query.maxDepth ? parseInt(req.query.maxDepth as string, 10) : undefined;
  const targetNodeIds = req.query.targetNodeIds ? (req.query.targetNodeIds as string).split(",") : [];

  if (!recordingId || !currentNodeId) {
    ws.close(1008, "recordingId and currentNodeId required");
    return;
  }
  handleMockSession(ws as any, recordingId, currentNodeId, includePrecap, maxDepth, targetNodeIds);
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
    note: "Scaffold serving dummy data per calltree-api-contract.md",
  });
});

app.listen(PORT, () => {
  console.log(`CallTree backend listening on http://localhost:${PORT}`);
});
