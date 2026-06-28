// transcription/index.ts — Provider factory.
//
// Reads TRANSCRIPTION_PROVIDER from the environment and returns the
// corresponding TranscriptionProvider implementation.
//
// Supported values:
//   "openai"   (default) — OpenAI Realtime gpt-realtime-2, two connections per session
//   "deepgram"           — Deepgram Nova-3 + diarization (stub, not yet implemented)

import type { TranscriptionProvider } from "./provider.js";
import { OpenAIProvider } from "./openai.js";
import { DeepgramProvider } from "./deepgram.js";
import type { Id } from "../types.js";

export function createProvider(recordingId: Id): TranscriptionProvider {
  const p = (process.env.TRANSCRIPTION_PROVIDER ?? "openai").toLowerCase();

  switch (p) {
    case "deepgram":
      return new DeepgramProvider(recordingId);
    case "openai":
    default:
      return new OpenAIProvider(recordingId);
  }
}

export type { TranscriptionProvider, SpeakerStream } from "./provider.js";
