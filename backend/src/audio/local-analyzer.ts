// local-analyzer.ts — Node wrapper around the Python librosa script.
//
// Writes the segment list to a temp file, spawns audio_pipeline.py, reads
// stdout, and parses the result into AudioScoreByIndex.
//
// Environment variables:
//   PYTHON_BIN                path to python binary (default: "python")
//   AUDIO_ANALYZER_TIMEOUT_MS max ms to wait for the script (default: 15000)
//
// Throws on non-zero exit or timeout so the caller can catch and fall back
// to NullAudioAnalyzer / transcript-only scoring.

import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  AudioAnalyzeRequest,
  AudioAnalyzer,
  AudioScore,
  AudioScoreByIndex,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Convert a /data/-relative audio path to an absolute filesystem path. */
function resolveAudioPath(audioPath: string): string {
  if (audioPath.startsWith("/data/")) {
    // Map /data/... → <cwd>/data/...
    return resolve(process.cwd(), audioPath.replace(/^\//, ""));
  }
  return resolve(audioPath);
}

/** Write segments to a temp JSON file and return the path. */
async function writeTempSegments(segments: AudioAnalyzeRequest["segments"]): Promise<string> {
  const fileName = `calltree-segments-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const filePath = join(tmpdir(), fileName);
  await writeFile(filePath, JSON.stringify(segments), "utf-8");
  return filePath;
}

/** Parse the Python script's stdout into AudioScoreByIndex. */
function parseOutput(stdout: string): AudioScoreByIndex {
  const map: AudioScoreByIndex = new Map();
  let parsed: { audioScores?: unknown[] };

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`[audio] Python output is not valid JSON: ${stdout.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.audioScores)) {
    throw new Error(`[audio] Unexpected output shape — missing audioScores array`);
  }

  for (const entry of parsed.audioScores) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const idx = Number(e["transcriptIndex"]);
    if (isNaN(idx)) continue;

    const score: AudioScore = {
      provider: "local",
    };

    if (typeof e["wpm"] === "number")           score.wpm = e["wpm"];
    if (typeof e["silenceRatio"] === "number")  score.silenceRatio = e["silenceRatio"];
    if (typeof e["energy"] === "number")        score.energy = e["energy"];
    if (typeof e["fillerCount"] === "number")   score.fillerCount = e["fillerCount"];
    if (typeof e["pitchVariance"] === "number") score.pitchVariance = e["pitchVariance"];

    map.set(idx, score);
  }

  return map;
}

export class LocalAudioAnalyzer implements AudioAnalyzer {
  name = "local" as const;

  async analyze({ audioPath, segments }: AudioAnalyzeRequest): Promise<AudioScoreByIndex> {
    const resolvedAudio = resolveAudioPath(audioPath);
    const segmentsFile = await writeTempSegments(segments);

    const pythonBin = process.env["PYTHON_BIN"] ?? "python";
    const timeoutMs = Number(process.env["AUDIO_ANALYZER_TIMEOUT_MS"] ?? 15_000);
    // The script lives relative to the backend working directory.
    const scriptPath = resolve(process.cwd(), "python/audio_pipeline.py");

    let stdout: string;
    try {
      const result = await execFileAsync(
        pythonBin,
        [scriptPath, "--audio", resolvedAudio, "--segments-json", segmentsFile],
        { timeout: timeoutMs },
      );
      stdout = result.stdout;
    } catch (err) {
      // Rethrow with a cleaner message; stderr from the script is in err.stderr.
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      throw new Error(
        `[audio] Python script failed: ${e.message}${e.stderr ? `\n${e.stderr}` : ""}`,
      );
    } finally {
      // Best-effort cleanup of the temp file.
      unlink(segmentsFile).catch(() => undefined);
    }

    return parseOutput(stdout);
  }
}
