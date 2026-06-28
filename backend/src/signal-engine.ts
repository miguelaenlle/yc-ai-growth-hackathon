// signal-engine.ts — Hybrid signal metrics computation.
//
// computeMetrics() is designed as a two-source pipeline:
//   Source 1: Keyword heuristics applied to transcript text.
//   Source 2: Simple audio features from the audio/prosody pipeline.
//
// Neither source mutates the tree node directly. The caller receives a new
// SignalMetrics object and passes it to updateNodeMetrics() + persist().

import type { SignalMetrics, TranscriptSegment } from "./types.js";
import type { AudioScore } from "./audio/types.js";

// ---------------------------------------------------------------------------
// Internal delta accumulator
// ---------------------------------------------------------------------------

interface MetricsDelta {
  confidence: number;
  hesitation: number;
  enthusiasm: number;
}

const zeroDelta = (): MetricsDelta => ({
  confidence: 0,
  hesitation: 0,
  enthusiasm: 0,
});

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const clamp01 = (v: number): number => clamp(v, 0, 1);

const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Heuristic phrase banks
// ---------------------------------------------------------------------------

const SELLER_WEAK_PATTERNS: RegExp[] = [
  /\buh\b/i,
  /\bum\b/i,
  /\berm\b/i,
  /\bi think\b/i,
  /\bprobably\b/i,
  /\bmaybe\b/i,
  /\bsort of\b/i,
  /\bkind of\b/i,
  /\bnot sure\b/i,
  /\broadmap\b/i,
  /\bupcoming feature\b/i,
  /\bcoming soon\b/i,
  /\bwe'?re working on it\b/i,
  /\beventually\b/i,
  /\bnot yet\b/i,
  /\bdon'?t have\b/i,
];

const SELLER_STRONG_PATTERNS: RegExp[] = [
  /\bsql\b/i,
  /\bconnector(s)?\b/i,
  /\bno migration\b/i,
  /\bkeep tableau\b/i,
  /\bworkaround\b/i,
  /\balternative\b/i,
  /\bbridge\b/i,
  /\bright now\b/i,
  /\btoday\b/i,
  /\bhere'?s how\b/i,
  /\bnext step\b/i,
];

const BUYER_POSITIVE_PATTERNS: RegExp[] = [
  /\bthat works\b/i,
  /\bactually works\b/i,
  /\bmakes sense\b/i,
  /\bhelpful\b/i,
  /\bsounds good\b/i,
  /\bgreat\b/i,
  /\bperfect\b/i,
  /\blet'?s\b/i,
  /\bdemo\b/i,
  /\bcalendar\b/i,
  /\bbook\b/i,
  /\bsend times\b/i,
];

const BUYER_NEGATIVE_PATTERNS: RegExp[] = [
  /\bsend me the deck\b/i,
  /\bsend the deck\b/i,
  /\bi'?ll take a look\b/i,
  /\bi'?ll think\b/i,
  /\bmaybe later\b/i,
  /\bnot a priority\b/i,
  /\bnot interested\b/i,
  /\bcircle back\b/i,
  /\bwe'?ll see\b/i,
  /\bnot sure\b/i,
];

// Energy varies a lot by mic/file, so keep this conservative.
// Energy >= 0.05 is treated as strong for the MVP.
const STRONG_ENERGY = 0.05;

// ---------------------------------------------------------------------------
// computeMetrics — main exported function
// ---------------------------------------------------------------------------

/**
 * Compute updated SignalMetrics for the node that is active during `segment`.
 *
 * @param segment      - The transcript segment just appended.
 * @param current      - The node's current metrics (read-only).
 * @param audioScore   - Optional V1 audio/prosody data for this segment.
 * @returns            A new SignalMetrics object with all values clamped to [0, 1].
 */
export function computeMetrics(
  segment: TranscriptSegment,
  current: SignalMetrics,
  audioScore?: AudioScore,
): SignalMetrics {
  const delta = zeroDelta();
  const text = normalize(segment.text);

  applyTranscriptHeuristics(delta, segment, text);
  applyTimingHeuristics(delta, segment, audioScore);

  if (audioScore) {
    applyAudioHeuristics(delta, segment, audioScore);
  }

  return {
    confidence: round2(clamp01(current.confidence + delta.confidence)),
    hesitation: round2(clamp01(current.hesitation + delta.hesitation)),
    enthusiasm: round2(clamp01(current.enthusiasm + delta.enthusiasm)),
  };
}

// ---------------------------------------------------------------------------
// Source 1 — transcript/text heuristics
// ---------------------------------------------------------------------------

function applyTranscriptHeuristics(
  delta: MetricsDelta,
  segment: TranscriptSegment,
  text: string,
): void {
  if (segment.speaker === "seller") {
    const weakScore = matchScore(text, SELLER_WEAK_PATTERNS);
    const strongScore = matchScore(text, SELLER_STRONG_PATTERNS);

    // Weak seller language means the rep sounds less certain.
    delta.hesitation += 0.16 * weakScore;
    delta.confidence -= 0.16 * weakScore;

    // Strong seller language means the rep offered a concrete path forward.
    delta.confidence += 0.18 * strongScore;
    delta.hesitation -= 0.12 * strongScore;

    // Seller enthusiasm is not the main product signal, but constructive momentum helps.
    delta.enthusiasm += 0.06 * strongScore;
  }

  if (segment.speaker === "buyer") {
    const positiveScore = matchScore(text, BUYER_POSITIVE_PATTERNS);
    const negativeScore = matchScore(text, BUYER_NEGATIVE_PATTERNS);

    // Buyer enthusiasm is the important buyer-side metric.
    delta.enthusiasm += 0.20 * positiveScore;
    delta.enthusiasm -= 0.22 * negativeScore;

    // Positive buyer language usually means the call is progressing.
    delta.confidence += 0.08 * positiveScore;
    delta.confidence -= 0.08 * negativeScore;

    // Negative/stalling language often follows uncertainty.
    delta.hesitation += 0.08 * negativeScore;
  }
}

// ---------------------------------------------------------------------------
// Source 1.5 — timing heuristics from transcript timestamps
// ---------------------------------------------------------------------------

function applyTimingHeuristics(
  delta: MetricsDelta,
  segment: TranscriptSegment,
  audioScore?: AudioScore,
): void {
  const wpm = audioScore?.wpm ?? estimateWpm(segment);

  if (wpm === null) return;

  // Slow speech can indicate hesitation, especially for seller answers.
  if (wpm < 95) {
    delta.hesitation += segment.speaker === "seller" ? 0.08 : 0.04;
    delta.confidence -= segment.speaker === "seller" ? 0.06 : 0.03;
  } else if (wpm >= 120 && wpm <= 190) {
    // Normal speaking pace is a mild confidence signal.
    delta.confidence += 0.03;
  } else if (wpm > 210) {
    // Very fast speech can be energetic, but also slightly less controlled.
    delta.enthusiasm += 0.04;
    delta.hesitation += 0.02;
  }
}

// ---------------------------------------------------------------------------
// Source 2 — simple V1 audio heuristics
// ---------------------------------------------------------------------------

function applyAudioHeuristics(
  delta: MetricsDelta,
  segment: TranscriptSegment,
  audioScore: AudioScore,
): void {
  if (audioScore.silenceRatio !== undefined) {
    const silence = clamp01(audioScore.silenceRatio);

    // Silence/pause inside a segment is the simplest useful audio hesitation signal.
    delta.hesitation += 0.18 * silence;
    delta.confidence -= 0.10 * silence;

    if (segment.speaker === "buyer") {
      delta.enthusiasm -= 0.10 * silence;
    }
  }

  if (audioScore.energy !== undefined) {
    const energyScore = normalizeEnergy(audioScore.energy);

    // Strong voice energy helps confidence. Low energy hurts it.
    delta.confidence += 0.10 * energyScore;
    delta.confidence -= 0.06 * (1 - energyScore);

    // Energy is especially useful for buyer enthusiasm.
    if (segment.speaker === "buyer") {
      delta.enthusiasm += 0.14 * energyScore;
      delta.enthusiasm -= 0.06 * (1 - energyScore);
    }
  }

  if (audioScore.fillerCount !== undefined && audioScore.fillerCount > 0) {
    const fillerScore = clamp01(audioScore.fillerCount / 3);
    delta.hesitation += 0.10 * fillerScore;
    delta.confidence -= 0.08 * fillerScore;
  }

  if (audioScore.pitchVariance !== undefined) {
    const pitchVariation = clamp01(audioScore.pitchVariance);

    // Keep pitch low-weight. It can mean enthusiasm, but it can also mean stress.
    if (segment.speaker === "buyer") {
      delta.enthusiasm += 0.06 * pitchVariation;
    } else {
      delta.enthusiasm += 0.03 * pitchVariation;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[']/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchScore(text: string, patterns: RegExp[]): number {
  const matches = patterns.reduce((count, pattern) => {
    return count + (pattern.test(text) ? 1 : 0);
  }, 0);

  // One match should matter; two or more matches should max out the phrase signal.
  return clamp01(matches / 2);
}

function estimateWpm(segment: TranscriptSegment): number | null {
  const durationMs = segment.tEndMs - segment.tStartMs;
  if (durationMs <= 0) return null;

  const words = normalize(segment.text).split(/\s+/).filter(Boolean).length;
  if (words === 0) return null;

  const minutes = durationMs / 60000;
  return words / minutes;
}

function normalizeEnergy(energy: number): number {
  if (!Number.isFinite(energy) || energy <= 0) return 0;
  return clamp01(energy / STRONG_ENERGY);
}
