// provider-analyzer.ts — Stub for third-party emotion/audio providers.
//
// Slot reserved for ReadingMinds, Hume, or any custom HTTP-based provider.
// The factory (index.ts) will instantiate this when AUDIO_ANALYZER=custom.
// Not wired to any real API yet — throws immediately so the server falls back
// to NullAudioAnalyzer / transcript-only scoring.

import type {
  AudioAnalyzeRequest,
  AudioAnalyzer,
  AudioScoreByIndex,
} from "./types.js";

export class ProviderAudioAnalyzer implements AudioAnalyzer {
  name = "custom" as const;

  async analyze(_request: AudioAnalyzeRequest): Promise<AudioScoreByIndex> {
    throw new Error(
      "ProviderAudioAnalyzer is not implemented yet. " +
        "Set AUDIO_ANALYZER=local or AUDIO_ANALYZER=none instead.",
    );
  }
}
