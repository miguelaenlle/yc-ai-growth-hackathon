// transcription/provider.ts — STT provider abstraction.
//
// Every provider must implement TranscriptionProvider.
// live.ts calls createStream() once per speaker per session, then pipes
// raw PCM audio into the returned SpeakerStream.

import type { TranscriptSegment } from "../types.js";

/** Handle for one speaker's audio stream to the STT provider. */
export interface SpeakerStream {
  /** Send a chunk of raw PCM-16 audio (as a Buffer). */
  sendAudio(pcm16: Buffer): void;
  /** Cleanly close this speaker's connection to the provider. */
  close(): void;
}

/**
 * A TranscriptionProvider manages STT for one live call session.
 * It is instantiated once per session by the factory in index.ts.
 */
export interface TranscriptionProvider {
  /**
   * Open a transcription stream for one speaker.
   * Called once for "seller" and once for "buyer" at session start.
   *
   * @param speaker   - Which side of the call this stream belongs to.
   * @param onSegment - Called with a completed TranscriptSegment after each turn.
   * @returns         A SpeakerStream handle for sending audio and closing.
   */
  createStream(
    speaker: "seller" | "buyer",
    onSegment: (seg: TranscriptSegment) => Promise<void>,
  ): SpeakerStream;
}
