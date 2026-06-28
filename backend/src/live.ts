// live.ts — Live call session handler.
//
// handleLiveSession() is called by server.ts when the single /live/session/:id
// WebSocket is established. It:
//
//  1. Instantiates the configured TranscriptionProvider (OpenAI by default)
//  2. Creates one SpeakerStream for seller and one for buyer
//  3. Parses incoming browser WS messages: { speaker: "seller"|"buyer", audio: "<base64 pcm16>" }
//     and routes audio to the correct SpeakerStream
//  4. Each completed TranscriptSegment flows through processSegment() →
//     GPT tree routing → signal metrics → SSE LiveEvents
//  5. On buyer turns, optionally fires generateAssistCard() (ENABLE_ASSIST_CARD flag)

import WebSocket from "ws";

import { getRecording, getTree } from "./store.js";
import { processSegment } from "./pipeline.js";
import { generateAssistCard } from "./assist.js";
import { getProductInfo } from "./product.js";
import { createProvider } from "./transcription/index.js";
import type { Id, LiveEvent, TranscriptSegment } from "./types.js";

import dotenv from "dotenv";
dotenv.config();

export function handleLiveSession(
  sessionWs: WebSocket,
  recordingId: Id,
  emitEvent: (recordingId: Id, event: LiveEvent) => void,
): void {
  const rec = getRecording(recordingId);
  if (!rec) {
    console.error("[live] Recording not found:", recordingId);
    sessionWs.close(1008, "Recording not found");
    return;
  }

  const tree = getTree(rec.treeId);
  if (!tree) {
    console.error("[live] Tree not found:", rec.treeId);
    sessionWs.close(1008, "Tree not found");
    return;
  }

  const productContext = getProductInfo(rec.callId);
  let routingQueue = Promise.resolve();
  const recentConversation: { role: string; text: string }[] = [];
  const emit = (event: LiveEvent) => emitEvent(recordingId, event);

  const onSegment = (speaker: "seller" | "buyer") =>
    async (seg: TranscriptSegment): Promise<void> => {
      rec.transcript.push(seg);
      emit({ type: "transcript", segment: seg });
      recentConversation.push({ role: speaker, text: seg.text });

      routingQueue = routingQueue.then(async () => {
        await processSegment(rec, tree, seg, emit, recentConversation);

        if (speaker === "buyer" && process.env.ENABLE_ASSIST_CARD === "true") {
          generateAssistCard(seg.text, productContext, rec.transcript)
            .then((card) => {
              if (!card) return;
              rec.aiNotes = card;
              emit({ type: "notes", card });
            })
            .catch((e) => console.error("[live] generateAssistCard error:", e));
        }
      }).catch((e) => console.error("[live] routing queue error:", e));
    };

  // Create one SpeakerStream per speaker from the configured provider
  const provider = createProvider(recordingId);
  const sellerStream = provider.createStream("seller", onSegment("seller"));
  const buyerStream = provider.createStream("buyer", onSegment("buyer"));

  console.log(`[live] Session started for recording ${recordingId} (provider: ${process.env.TRANSCRIPTION_PROVIDER ?? "openai"})`);

  // Route tagged audio from the single browser WebSocket to the correct stream
  sessionWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { speaker?: string; audio?: string };

      if (!msg.audio) return;

      const pcm16 = Buffer.from(msg.audio, "base64");

      if (msg.speaker === "seller") {
        sellerStream.sendAudio(pcm16);
      } else if (msg.speaker === "buyer") {
        buyerStream.sendAudio(pcm16);
      }
    } catch {
      // Ignore unparseable frames
    }
  });

  sessionWs.on("close", () => {
    console.log(`[live] Session WebSocket closed for ${recordingId}`);
    sellerStream.close();
    buyerStream.close();
  });
}
