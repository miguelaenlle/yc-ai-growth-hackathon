// audio/types.ts — Shared types for the audio analysis pipeline.
//
// Every analyzer (local, ReadingMinds, Hume, ...) must implement AudioAnalyzer
// and return AudioScoreByIndex. The rest of the backend only sees this contract.

import type { TranscriptSegment } from "../types.js";

export type AudioProvider = "local" | "readingminds" | "hume" | "custom";

/**
 * Normalized audio/prosody features for a single transcript segment.
 * All fields are optional — analyzers only populate what they can compute.
 * Provider-specific raw data goes in rawProviderPayload for debugging only.
 */
export type AudioScore = {
  /** Words per minute — derived from word count + segment duration. */
  wpm?: number;
  /** 0..1 — fraction of the segment that was quiet/silent. Higher → more hesitation. */
  silenceRatio?: number;
  /** RMS-like voice energy. Scale varies by mic; keep scoring weight conservative. */
  energy?: number;
  /** Filler word count ("uh", "um", "erm", "hmm") detected in this segment. */
  fillerCount?: number;
  /** Pitch variance 0..1 — not populated in local v1; reserved for future analyzers. */
  pitchVariance?: number;

  /** Which analyzer produced this score. */
  provider?: AudioProvider;
  /**
   * Provider-level emotion/expression label, if any.
   * Examples: "Enthusiastic", "Neutral", "Confrontational" (ReadingMinds-style).
   */
  providerLabel?: string;
  /**
   * Provider intensity score, if any.
   * Examples: ReadingMinds-style 1..9 intensity.
   */
  providerIntensity?: number;
  /** Raw provider response — for debugging only; do not use in product logic. */
  rawProviderPayload?: unknown;
};

/** Map from transcriptIndex → AudioScore, one entry per analyzed segment. */
export type AudioScoreByIndex = Map<number, AudioScore>;

export type AudioAnalyzeRequest = {
  /** Absolute or /data/-relative path to the audio file. */
  audioPath: string;
  /** Transcript segments to analyze — each has index, text, tStartMs, tEndMs. */
  segments: TranscriptSegment[];
};

/**
 * Interface every audio analyzer must implement.
 * Returning an empty Map is always a valid response (no audio = transcript-only scoring).
 */
export interface AudioAnalyzer {
  name: AudioProvider;
  analyze(request: AudioAnalyzeRequest): Promise<AudioScoreByIndex>;
}
