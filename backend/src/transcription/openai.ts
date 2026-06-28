// transcription/openai.ts — OpenAI Realtime STT provider.
//
// Uses the gpt-realtime-2 model in transcription-only mode (empty instructions,
// create_response: false). Mirrors the session shape from mock.ts exactly.
//
// Two separate OpenAI Realtime connections are opened per session — one for
// the seller and one for the buyer — because the Realtime API only handles
// one audio input stream per connection.

import WebSocket from "ws";
import type { SpeakerStream, TranscriptionProvider } from "./provider.js";
import type { TranscriptSegment } from "../types.js";
import type { Id } from "../types.js";

import dotenv from "dotenv";
dotenv.config();

function buildTranscriptionSession() {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.8,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
            create_response: false,
          },
          transcription: { model: "whisper-1" },
        },
      },
      instructions: "",
    },
  };
}

class OpenAISpeakerStream implements SpeakerStream {
  private openaiWs: WebSocket;
  private audioChunks: Buffer[] = [];
  private segmentIndex = 0;
  private turnStartMs = Date.now();

  constructor(
    speaker: "seller" | "buyer",
    recordingId: Id,
    onSegment: (seg: TranscriptSegment) => Promise<void>,
  ) {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";

    this.openaiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        voice: "marin",
      },
    });

    this.openaiWs.on("open", () => {
      console.log(`[openai-provider] Realtime open for ${speaker} (${recordingId})`);
      this.openaiWs.send(JSON.stringify(buildTranscriptionSession()));
    });

    this.openaiWs.on("message", async (data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      const type = event["type"] as string;

      if (type !== "response.audio.delta" && type !== "response.output_audio.delta") {
        console.log(`[openai-provider][${speaker}] event:`, type);
      }

      if (type === "input_audio_buffer.speech_started") {
        this.audioChunks = [];
        this.turnStartMs = Date.now();
      }

      if (type === "conversation.item.input_audio_transcription.completed") {
        const transcript = (event["transcript"] as string | undefined)?.trim();
        if (!transcript) return;

        const seg: TranscriptSegment = {
          index: this.segmentIndex,
          speaker,
          text: transcript,
          tStartMs: this.turnStartMs,
          tEndMs: Date.now(),
        };
        this.segmentIndex++;

        await onSegment(seg);
      }
    });

    this.openaiWs.on("close", (code, reason) => {
      console.log(`[openai-provider] Realtime closed for ${speaker} — code ${code} ${reason.toString()}`);
    });

    this.openaiWs.on("error", (err) => {
      console.error(`[openai-provider] WS error (${speaker}):`, err);
    });
  }

  sendAudio(pcm16: Buffer): void {
    if (this.openaiWs.readyState !== WebSocket.OPEN) return;
    const base64 = pcm16.toString("base64");
    this.openaiWs.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: base64,
    }));
  }

  close(): void {
    this.openaiWs.close();
  }
}

export class OpenAIProvider implements TranscriptionProvider {
  private recordingId: Id;

  constructor(recordingId: Id) {
    this.recordingId = recordingId;
  }

  createStream(
    speaker: "seller" | "buyer",
    onSegment: (seg: TranscriptSegment) => Promise<void>,
  ): SpeakerStream {
    return new OpenAISpeakerStream(speaker, this.recordingId, onSegment);
  }
}
