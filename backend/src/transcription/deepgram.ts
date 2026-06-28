// transcription/deepgram.ts — Deepgram Nova 3 provider (stub).
//
// To activate: set TRANSCRIPTION_PROVIDER=deepgram in .env and add DEEPGRAM_API_KEY.
//
// Deepgram Nova 3 supports real-time diarization via `diarize=true`, meaning
// a SINGLE audio stream from the browser can identify both speakers automatically.
// When implemented, this provider needs only ONE connection (not two), and the
// frontend SessionPage can send raw PCM without a speaker tag.
//
// WS URL:
//   wss://api.deepgram.com/v1/listen
//     ?model=nova-3
//     &diarize=true
//     &punctuate=true
//     &vad_events=true
//     &encoding=linear16
//     &sample_rate=16000
//     &channels=1
//
// Auth: "Authorization: Token <DEEPGRAM_API_KEY>" header
//
// Incoming audio: raw PCM-16 bytes
//
// Outgoing events (JSON):
//   { type: "Results", channel: { alternatives: [{ words: [{ word, speaker }] }] }, speech_final: true }
//
// Speaker mapping: first speaker index seen → "seller", second → "buyer"

import type { SpeakerStream, TranscriptionProvider } from "./provider.js";
import type { TranscriptSegment } from "../types.js";
import type { Id } from "../types.js";

// Placeholder SpeakerStream that throws if used before implementation.
class DeepgramSpeakerStream implements SpeakerStream {
  sendAudio(_pcm16: Buffer): void {
    throw new Error("DeepgramProvider is not yet implemented.");
  }
  close(): void {}
}

export class DeepgramProvider implements TranscriptionProvider {
  constructor(_recordingId: Id) {
    console.warn("[deepgram-provider] DeepgramProvider is a stub — not yet implemented.");
  }

  createStream(
    _speaker: "seller" | "buyer",
    _onSegment: (seg: TranscriptSegment) => Promise<void>,
  ): SpeakerStream {
    return new DeepgramSpeakerStream();
  }
}
