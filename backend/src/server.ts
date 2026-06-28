// CallTree backend — single Express process serving the API contract.
//
// Phase 1 (A) — read endpoints serve real seed data.
// Phase 2 (B) — recording lifecycle endpoints are fully implemented.
// Phase 3 (C) — SSE live stream + signal engine wired; agent/notes keyword-scanned.
// Phase 5+    — POST /transcribe and POST /tts remain stubs.

import cors from "cors";
import express, { type Request, type Response } from "express";
import expressWs from "express-ws";
import { type WebSocket } from "ws";
import multer from "multer";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleLiveSession } from "./live.js";
import { generateAssistCard } from "./assist.js";
import { getProductInfo } from "./product.js";
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
  getNodeById,
  getWeakNodes,
  matchOrCreateBranch,
  routeTranscriptToNode,
  updateNodeMetrics,
} from "./tree-ops.js";
import { computeMetrics } from "./signal-engine.js";
import { createAudioAnalyzer } from "./audio/index.js";
import type { AudioScoreByIndex } from "./audio/types.js";
import type {
  AiFeedback,
  AiNotes,
  AssistCard,
  Call,
  CallDetail,
  CallSummary,
  CreateCallReq,
  LiveEvent,
  MockTurnReq,
  PracticeTarget,
  Recording,
  TraversalStep,
  Tree,
  TreeNode,
} from "./types.js";
import { handleMockSession } from "./mock.js";
import { getOrBuildWalkthrough } from "./walkthrough.js";

const { app } = expressWs(express());
const PORT = Number(process.env.PORT) || 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());

// Serve generated/seed audio from /data/audio (referenced by audioPath/audioUrl).
app.use("/data", express.static(join(__dirname, "../public/data")));

// Audio analyzer — created once at startup. AUDIO_ANALYZER env var selects
// which implementation is used (local | none | custom). Falls back gracefully
// to transcript-only scoring if analyze() throws.
const audioAnalyzer = createAudioAnalyzer();

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

const notFound = (res: Response, message: string) =>
  fail(res, 404, "not_found", message);

// ---------------------------------------------------------------------------
// SSE connection registry — Phase 3
// Maps recordingId → set of active SSE Response objects.
// emitEvent() fans out a LiveEvent to all connected clients for a recording.
// ---------------------------------------------------------------------------

const sseClients = new Map<string, Set<Response>>();

function emitEvent(recordingId: string, event: LiveEvent): void {
  const clients = sseClients.get(recordingId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

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

  const tree: Tree = { id: treeId, callId, rootNodeId, nodes: [rootNode] };

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
    traversal: { initialNodeId: rootNodeId, finalNodeId: rootNodeId, steps: [] },
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
    traversal: { initialNodeId, finalNodeId: initialNodeId, steps: [] },
    aiNotes: null,
    aiFeedback: null,
  };

  putRecording(rec);
  call.recordingIds.push(recordingId);
  persist();

  res.status(201).json({ recordingId });
});

// 7. PATCH /recordings/:id (AppendReq) → 202 { ok, currentNodeId }
app.patch("/recordings/:id", async (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);

  const { segments, steps } = req.body ?? {};
  if (!Array.isArray(segments) || segments.length === 0) {
    return fail(res, 400, "bad_input", "segments array required");
  }

  const tree = getTree(rec.treeId);
  if (!tree) return notFound(res, `tree ${rec.treeId} not found`);

  // Run audio analyzer once per batch before the segment loop.
  // On failure (missing file, Python crash, timeout) we warn and fall back to
  // transcript-only scoring — every audioScores.get() will return undefined.
  let audioScores: AudioScoreByIndex = new Map();
  if (rec.audioPath) {
    try {
      audioScores = await audioAnalyzer.analyze({ audioPath: rec.audioPath, segments });
    } catch (err) {
      console.warn("[audio] analyzer failed; using transcript-only scoring", err);
    }
  }

  // Append segments and emit a transcript event for each one
  for (const seg of segments) {
    rec.transcript.push(seg);
    emitEvent(rec.id, { type: "transcript", segment: seg });
  }

  if (Array.isArray(steps) && steps.length > 0) {
    // Caller supplied explicit traversal steps — use them directly
    for (const step of steps) {
      rec.traversal.steps.push(step);
      const toNode = getNodeById(tree, step.toNodeId);
      if (toNode) {
        emitEvent(rec.id, { type: "move", step, node: toNode });
      }
    }
    rec.traversal.finalNodeId = steps[steps.length - 1].toNodeId;
  } else {
    // Run the tree engine to derive traversal steps from each segment
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

        const toNode = getNodeById(tree, currentNodeId);
        if (toNode) {
          emitEvent(rec.id, { type: "move", step, node: toNode });
        }
      }

      // Run the signal engine on the active node and emit metrics.
      // audioScore is undefined when the audio analyzer returned no entry for
      // this segment index — computeMetrics falls back to keyword-only mode.
      const activeNode = getNodeById(tree, currentNodeId);
      if (activeNode) {
        const audioScore = audioScores.get(seg.index);
        const newMetrics = computeMetrics(seg, activeNode.metrics, audioScore);
        updateNodeMetrics(tree, currentNodeId, newMetrics);
        emitEvent(rec.id, { type: "metrics", nodeId: currentNodeId, metrics: newMetrics });
      }
    }
    rec.traversal.finalNodeId = currentNodeId;
  }

  // Update lengthMs to the end of the last segment
  rec.lengthMs = segments[segments.length - 1].tEndMs ?? rec.lengthMs;

  putRecording(rec);
  putTree(tree); // persist updated node metrics
  persist();

  res.status(202).json({ ok: true, currentNodeId: rec.traversal.finalNodeId });
});

// 8. POST /recordings/:id/feedback → AiFeedback
app.post("/recordings/:id/feedback", (req: Request, res: Response) => {
  const rec = getRecording(req.params.id);
  if (!rec) return notFound(res, `recording ${req.params.id} not found`);

  if (rec.aiFeedback) return res.json(rec.aiFeedback);

  const tree = getTree(rec.treeId);
  if (!tree) return notFound(res, `tree ${rec.treeId} not found`);

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
// C · Realtime & agents  — Phase 3 live; Phase 5 stubs remain
// ---------------------------------------------------------------------------

// 10. GET /stream/:recordingId (SSE) → LiveEvent stream
app.get("/stream/:recordingId", (req: Request, res: Response) => {
  const { recordingId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  // Register this client in the SSE registry
  if (!sseClients.has(recordingId)) sseClients.set(recordingId, new Set());
  sseClients.get(recordingId)!.add(res);

  const ping = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.get(recordingId)?.delete(res);
    // Clean up the map entry if no clients remain
    if (sseClients.get(recordingId)?.size === 0) sseClients.delete(recordingId);
    res.end();
  });
});

// 11. POST /transcribe (multipart) → { segments }
app.post("/transcribe", (_req: Request, res: Response) => {
  // TODO(phase5): forward audio to Whisper, offset timestamps by tStartMs,
  // continue index from the recording's transcript length.
  // When implemented, pass prosody data as AudioScore to computeMetrics().
  res.json({ segments: [] });
});

// 12. POST /agent/notes (NotesReq) → AssistCard
// Accepts { window: TranscriptSegment[], recordingId, buyerUtterance? }
// Uses GPT + web search to generate a real-time assist card for the seller.
app.post("/agent/notes", async (req: Request, res: Response) => {
  const { window: windowSegments, recordingId, buyerUtterance } = req.body ?? {};

  const rec = typeof recordingId === "string" ? getRecording(recordingId) : null;
  const productContext = rec ? getProductInfo(rec.callId) : "Unknown product.";

  const latestUtterance: string =
    typeof buyerUtterance === "string"
      ? buyerUtterance
      : Array.isArray(windowSegments) && windowSegments.length > 0
        ? (windowSegments[windowSegments.length - 1] as { text?: string }).text ?? ""
        : "";

  const recentSegments = Array.isArray(windowSegments) ? windowSegments : [];

  const card = await generateAssistCard(latestUtterance, productContext, recentSegments);

  // generateAssistCard returns null for short/filler utterances
  if (!card) {
    return res.json({ skipped: true, reason: "utterance too short" });
  }

  if (rec) {
    rec.aiNotes = card;
    putRecording(rec);
    persist();
    emitEvent(recordingId as string, { type: "notes", card });
  }

  res.json(card);
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
    // Emit a branch SSE event to all connected clients for this recording
    if (typeof recordingId === "string") {
      emitEvent(recordingId, { type: "branch", node: decision.node });
    }
    res.json({ node: decision.node });
  } else {
    res.json({ node: null, matchedNodeId: decision.matchedNodeId });
  }
});

// 14. POST /mock/turn (MockTurnReq) → { lines, proposedChild? }
app.post("/mock/turn", (req: Request<{}, {}, MockTurnReq>, res: Response) => {
  const { currentNodeId, role } = req.body ?? {};

  const lines: { speaker: "buyer" | "seller"; text: string }[] = [];

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
  // TODO(phase5): proxy to ElevenLabs (key server-side), save under /data/audio,
  // cache by hash(text+voiceId).
  res.json({ audioUrl: "/data/audio/tts_stub.mp3" });
});

// ---------------------------------------------------------------------------
// WS /mock/session/:recordingId — OpenAI Realtime API relay
// Bidirectional WebSocket: frontend sends mic audio up; backend relays to
// OpenAI Realtime API and forwards AI speech + transcripts back down.
// Requires OPENAI_API_KEY in the environment.
// ---------------------------------------------------------------------------

app.ws("/mock/session/:recordingId", (ws, req) => {
  const { recordingId } = req.params;
  const currentNodeId = req.query["currentNodeId"] as string;
  const includePrecap = req.query["includePrecap"] === "true";
  if (!recordingId || !currentNodeId) {
    ws.close(1008, "recordingId and currentNodeId required");
    return;
  }
  handleMockSession(ws as any, recordingId, currentNodeId, includePrecap);
});

// ---------------------------------------------------------------------------
// WS /live/session/:recordingId — unified live call session.
// A single browser WebSocket carries tagged audio for both seller and buyer:
//   { speaker: "seller"|"buyer", audio: "<base64 pcm16>" }
// live.ts routes each frame to the correct SpeakerStream internally.
// ---------------------------------------------------------------------------

app.ws("/live/session/:recordingId", (ws, req) => {
  const { recordingId } = req.params;
  if (!recordingId) { ws.close(1008, "recordingId required"); return; }
  console.log(`[live] Session connected for ${recordingId}`);
  handleLiveSession(ws as unknown as WebSocket, recordingId, emitEvent);
});

// ---------------------------------------------------------------------------
// POST /recordings/:id/audio — full call recording upload (end of call)
// Frontend uploads the merged audio file; backend saves it and updates audioPath.
// ---------------------------------------------------------------------------

const audioUpload = multer({ storage: multer.memoryStorage() });

app.post(
  "/recordings/:id/audio",
  audioUpload.single("audio"),
  async (req: Request, res: Response) => {
    const rec = getRecording(req.params.id);
    if (!rec) return notFound(res, `recording ${req.params.id} not found`);

    if (!req.file) return fail(res, 400, "bad_input", "audio file required (field: audio)");

    const dir = join(__dirname, "..", "public", "data", "audio", rec.id);
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, "full_call.webm");
    await fs.writeFile(filePath, req.file.buffer);

    rec.audioPath = `/data/audio/${rec.id}/full_call.webm`;
    rec.isActive = false;
    putRecording(rec);
    persist();

    res.json({ ok: true, audioPath: rec.audioPath });
  },
);

// ---------------------------------------------------------------------------

app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "calltree-backend",
    status: "ok",
    phase: "Phase 3 — SSE live stream + signal engine + WebSocket Realtime relay",
  });
});

app.listen(PORT, () => {
  console.log(`CallTree backend listening on http://localhost:${PORT}`);
});
