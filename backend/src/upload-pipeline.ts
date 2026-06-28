// upload-pipeline.ts — Async orchestrator for the POST /upload/call flow.
//
// After the HTTP handler returns { callId, treeId, recordingId } to the client,
// this function runs in the background and:
//   1. Transcribes the uploaded MP3 with ElevenLabs Scribe v2 (diarized)
//   2. Runs the local audio analyzer on all segments
//   3. Calls GPT-4o (via tree-generator.ts) to generate the full tree in one shot —
//      real path from the actual conversation + AI alternative paths from historical data
//   4. Persists the generated tree and recording traversal
//   5. Generates post-call feedback
//   6. Marks the recording as complete
//
// Progress is emitted as SSE { type: "processing", status: ... } events so the
// frontend can display a live progress indicator while waiting for the tree.

import { createAudioAnalyzer } from "./audio/index.js";
import { transcribeWithScribe } from "./transcription/elevenlabs-scribe.js";
import { generateCallTree, refreshStatCache } from "./tree-generator.js";
import { getRecording, getTree, persist, putRecording, putTree } from "./store.js";
import { buildAiFeedback } from "./practice-reco.js";
import type { LiveEvent, TraversalStep } from "./types.js";

// Shared audio analyzer instance — same factory as the main server uses.
const audioAnalyzer = createAudioAnalyzer();

/**
 * Run the full upload processing pipeline for a newly created recording.
 *
 * This function is intentionally fire-and-forget: the HTTP handler does NOT
 * await it. All errors are caught and logged; a failure emits a final
 * { type: "processing", status: "done", message: <error> } so the frontend
 * is never left hanging.
 *
 * @param recordingId - ID of the recording created by the upload handler.
 * @param audioPath   - Absolute filesystem path to the saved MP3 file.
 * @param emitFn      - SSE emitter for this recording's stream channel.
 */
export async function runUploadPipeline(
  recordingId: string,
  audioPath: string,
  emitFn: (event: LiveEvent) => void,
): Promise<void> {
  try {
    // -----------------------------------------------------------------------
    // 1. Transcribe with ElevenLabs Scribe v2
    // -----------------------------------------------------------------------
    emitFn({ type: "processing", status: "transcribing", message: "Transcribing audio with ElevenLabs Scribe v2…" });

    const segments = await transcribeWithScribe(audioPath);

    if (segments.length === 0) {
      console.warn(`[upload-pipeline] No segments returned for recording ${recordingId}; aborting.`);
      emitFn({ type: "processing", status: "done", message: "No speech detected in audio." });
      return;
    }

    console.log(`[upload-pipeline] Got ${segments.length} segments for recording ${recordingId}`);

    // Emit each transcript segment so SSE listeners see the transcript rail fill in
    for (const seg of segments) {
      emitFn({ type: "transcript", segment: seg });
    }

    // -----------------------------------------------------------------------
    // 2. Audio analysis (all segments; real-path nodes use their slice's scores)
    // -----------------------------------------------------------------------
    emitFn({ type: "processing", status: "analyzing", message: "Analyzing audio signals…" });

    let audioScores = new Map<number, import("./audio/types.js").AudioScore>();
    try {
      audioScores = await audioAnalyzer.analyze({ audioPath, segments });
      console.log(`[upload-pipeline] Audio analysis complete — ${audioScores.size} scores`);
    } catch (err) {
      console.warn("[upload-pipeline] Audio analyzer failed; using transcript-only scoring", err);
    }

    // -----------------------------------------------------------------------
    // 3. Generate the full tree in one GPT-4o call
    //    Real path (from transcript) + AI branches (from historical patterns)
    // -----------------------------------------------------------------------
    emitFn({ type: "processing", status: "routing", message: "Generating decision tree with AI…" });

    const rec = getRecording(recordingId);
    if (!rec) throw new Error(`Recording ${recordingId} not found mid-pipeline`);

    const { tree, traversal } = await generateCallTree(
      rec.treeId,
      rec.callId,
      segments,
      audioScores,
    );

    // Emit move events for each real-path traversal step so the tree lights up
    for (const step of traversal.steps) {
      const toNode = tree.nodes.find((n) => n.id === step.toNodeId);
      if (toNode) {
        emitFn({ type: "move", step: step as TraversalStep, node: toNode });
      }
    }

    // Emit metrics for each node that has real-path segments
    for (const node of tree.nodes) {
      emitFn({ type: "metrics", nodeId: node.id, metrics: node.metrics });
    }

    // -----------------------------------------------------------------------
    // 4. Persist the tree and update the recording
    // -----------------------------------------------------------------------
    rec.transcript = segments;
    rec.traversal = traversal;
    rec.lengthMs = segments[segments.length - 1].tEndMs;

    // Generate post-call feedback using the completed tree
    const feedback = buildAiFeedback(tree, traversal, { limit: 3 });
    rec.aiFeedback = feedback;
    rec.isActive = false;

    putTree(tree);
    putRecording(rec);
    persist();

    // Fold this call's outcome into the stat table so the next upload benefits from it.
    refreshStatCache();

    console.log(`[upload-pipeline] Pipeline complete for recording ${recordingId} — tree has ${tree.nodes.length} nodes`);

    // -----------------------------------------------------------------------
    // 5. Signal completion
    // -----------------------------------------------------------------------
    emitFn({ type: "processing", status: "done", message: "Call tree ready." });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[upload-pipeline] Fatal error for recording ${recordingId}:`, err);
    emitFn({ type: "processing", status: "done", message: `Processing failed: ${message}` });

    // Mark recording inactive so it doesn't appear stuck in the UI
    const rec = getRecording(recordingId);
    if (rec) {
      rec.isActive = false;
      putRecording(rec);
      persist();
    }
  }
}
