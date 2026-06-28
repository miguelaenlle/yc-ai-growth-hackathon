// null-analyzer.ts — No-op audio analyzer.
//
// Returns an empty Map for every request. Used when AUDIO_ANALYZER=none
// or as a safe in-process fallback when the local analyzer fails.
// The rest of the pipeline treats an empty map as "no audio data available"
// and falls back to transcript-only scoring in computeMetrics().

import type {
  AudioAnalyzeRequest,
  AudioAnalyzer,
  AudioScoreByIndex,
} from "./types.js";

export class NullAudioAnalyzer implements AudioAnalyzer {
  name = "local" as const;

  async analyze(_request: AudioAnalyzeRequest): Promise<AudioScoreByIndex> {
    return new Map();
  }
}
