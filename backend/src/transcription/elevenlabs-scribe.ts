// elevenlabs-scribe.ts — ElevenLabs Scribe v2 diarized transcription client.
//
// Uploads an MP3 file to the Scribe v2 endpoint, receives word-level objects
// with speaker_id labels, groups consecutive same-speaker words into turns, and
// returns a TranscriptSegment[] ready for the tree-routing pipeline.
//
// Speaker mapping:
//   speaker_0 → "seller"  (guaranteed to speak first per product assumption)
//   speaker_1 → "buyer"
//
// Requires: ELEVENLABS_API_KEY in environment.

import { readFile } from "node:fs/promises";
import type { TranscriptSegment } from "../types.js";

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

// ---------------------------------------------------------------------------
// ElevenLabs response types (internal — not exported)
// ---------------------------------------------------------------------------

interface ScribeWord {
  text: string;
  type: "word" | "spacing" | "audio_event";
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** e.g. "speaker_0", "speaker_1". May be absent for non-word tokens. */
  speaker_id?: string;
}

interface ScribeResponse {
  text: string;
  words: ScribeWord[];
  language_code?: string;
}

// ---------------------------------------------------------------------------
// Speaker mapping
// ---------------------------------------------------------------------------

/**
 * Map a Scribe speaker_id to the CallTree speaker role.
 * The first speaker_id encountered is always mapped to "seller".
 */
function buildSpeakerMap(words: ScribeWord[]): Map<string, "seller" | "buyer"> {
  const map = new Map<string, "seller" | "buyer">();
  for (const w of words) {
    if (!w.speaker_id) continue;
    if (!map.has(w.speaker_id)) {
      // First speaker seen → seller; all others → buyer
      map.set(w.speaker_id, map.size === 0 ? "seller" : "buyer");
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Word grouping → TranscriptSegment[]
// ---------------------------------------------------------------------------

/**
 * Group consecutive words with the same speaker_id into speaker turns.
 * Non-word tokens (spacing, audio_event) are skipped.
 * Each turn becomes one TranscriptSegment.
 */
function groupIntoSegments(
  words: ScribeWord[],
  speakerMap: Map<string, "seller" | "buyer">,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  let currentSpeakerId: string | null = null;
  let turnWords: ScribeWord[] = [];

  const flushTurn = () => {
    if (turnWords.length === 0 || currentSpeakerId === null) return;
    const speaker = speakerMap.get(currentSpeakerId);
    if (!speaker) return;

    const text = turnWords.map((w) => w.text).join("").trim();
    if (!text) return;

    segments.push({
      index: segments.length,
      speaker,
      text,
      tStartMs: Math.round(turnWords[0].start * 1000),
      tEndMs: Math.round(turnWords[turnWords.length - 1].end * 1000),
    });
  };

  for (const word of words) {
    // Skip non-word tokens (spacing, audio_event)
    if (word.type !== "word") continue;
    // Skip words without a speaker assignment
    if (!word.speaker_id) continue;

    if (word.speaker_id !== currentSpeakerId) {
      flushTurn();
      currentSpeakerId = word.speaker_id;
      turnWords = [];
    }

    turnWords.push(word);
  }

  flushTurn();
  return segments;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio file using ElevenLabs Scribe v2 with speaker diarization.
 *
 * @param audioPath - Absolute path to the MP3 (or other librosa-supported) file.
 * @returns Ordered TranscriptSegment[] with seller/buyer labels and ms timestamps.
 * @throws  If ELEVENLABS_API_KEY is missing or the API call fails.
 */
export async function transcribeWithScribe(audioPath: string): Promise<TranscriptSegment[]> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set in the environment.");
  }

  console.log(`[scribe] Transcribing ${audioPath} with ElevenLabs Scribe v2...`);

  const audioBuffer = await readFile(audioPath);
  const blob = new Blob([audioBuffer], { type: "audio/mpeg" });

  const form = new FormData();
  form.append("file", blob, "call.mp3");
  form.append("model_id", "scribe_v2");
  form.append("diarize", "true");
  form.append("num_speakers", "2");

  const response = await fetch(SCRIBE_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(no body)");
    throw new Error(
      `[scribe] ElevenLabs API error ${response.status}: ${errText}`,
    );
  }

  const data = (await response.json()) as ScribeResponse;

  if (!Array.isArray(data.words) || data.words.length === 0) {
    console.warn("[scribe] Scribe returned no words; returning empty transcript.");
    return [];
  }

  const speakerMap = buildSpeakerMap(data.words);
  console.log(
    `[scribe] Speaker map: ${[...speakerMap.entries()].map(([k, v]) => `${k}→${v}`).join(", ")}`,
  );

  const segments = groupIntoSegments(data.words, speakerMap);
  console.log(`[scribe] Produced ${segments.length} transcript segments.`);

  return segments;
}
