// audio/index.ts — Factory for the active AudioAnalyzer.
//
// Reads the AUDIO_ANALYZER environment variable and returns the matching
// analyzer. Falls back to LocalAudioAnalyzer for unrecognized values.
//
// Supported values:
//   local         — runs audio_pipeline.py via librosa (default)
//   none          — NullAudioAnalyzer, always returns empty map (transcript-only)
//   custom        — ProviderAudioAnalyzer stub (not wired; throws immediately)

export type { AudioAnalyzer, AudioScore, AudioScoreByIndex, AudioAnalyzeRequest, AudioProvider } from "./types.js";

import type { AudioAnalyzer } from "./types.js";
import { LocalAudioAnalyzer } from "./local-analyzer.js";
import { NullAudioAnalyzer } from "./null-analyzer.js";
import { ProviderAudioAnalyzer } from "./provider-analyzer.js";

export function createAudioAnalyzer(): AudioAnalyzer {
  const provider = process.env["AUDIO_ANALYZER"] ?? "local";

  switch (provider) {
    case "local":
      return new LocalAudioAnalyzer();

    case "none":
      return new NullAudioAnalyzer();

    case "custom":
    case "readingminds":
    case "hume":
      return new ProviderAudioAnalyzer();

    default:
      console.warn(
        `[audio] Unknown AUDIO_ANALYZER="${provider}", falling back to local.`,
      );
      return new LocalAudioAnalyzer();
  }
}
