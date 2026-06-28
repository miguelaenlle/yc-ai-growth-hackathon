#!/usr/bin/env python3
"""
audio_pipeline.py — Local audio analyzer for CallTree.

Loads an audio file with librosa, then for each transcript segment:
  - Slices the waveform by tStartMs / tEndMs
  - Computes silenceRatio (fraction of samples below amplitude threshold)
  - Computes energy (RMS of the slice)
  - Computes wpm (word count / segment duration in minutes)
  - Counts filler words from the segment text

Outputs JSON to stdout:
  { "audioScores": [ { transcriptIndex, wpm, silenceRatio, energy, fillerCount, provider } ] }

Usage:
  python audio_pipeline.py --audio <audio_path> --segments-json <segments_json_path>

Install dependencies (from backend/python/):
  python -m venv .venv
  .venv/Scripts/activate          # Windows
  source .venv/bin/activate       # Mac/Linux
  pip install -r requirements.txt
"""

import argparse
import json
import re
import sys

import librosa
import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Amplitude threshold below which a sample is considered silence.
# librosa normalizes to [-1, 1], so 0.01 is ~1% of full scale.
SILENCE_THRESHOLD = 0.01

# Filler words to count. Matches whole words only.
FILLER_PATTERNS = [
    re.compile(r"\buh\b", re.IGNORECASE),
    re.compile(r"\bum\b", re.IGNORECASE),
    re.compile(r"\berm\b", re.IGNORECASE),
    re.compile(r"\bhmm\b", re.IGNORECASE),
]

# ---------------------------------------------------------------------------
# Audio feature helpers
# ---------------------------------------------------------------------------


def compute_energy(audio_slice: np.ndarray) -> float:
    """RMS energy of an audio slice. Returns 0.0 for empty slices."""
    if len(audio_slice) == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio_slice ** 2)))


def compute_silence_ratio(audio_slice: np.ndarray) -> float:
    """Fraction of samples whose absolute amplitude is below SILENCE_THRESHOLD."""
    if len(audio_slice) == 0:
        return 1.0  # treat empty slice as fully silent
    silent_samples = np.sum(np.abs(audio_slice) < SILENCE_THRESHOLD)
    return float(silent_samples / len(audio_slice))


def compute_wpm(text: str, t_start_ms: int, t_end_ms: int) -> float | None:
    """Words per minute from word count and segment duration."""
    duration_ms = t_end_ms - t_start_ms
    if duration_ms <= 0:
        return None
    words = [w for w in text.strip().split() if w]
    if not words:
        return None
    minutes = duration_ms / 60_000
    return round(len(words) / minutes, 2)


def count_fillers(text: str) -> int:
    """Count filler words in text using FILLER_PATTERNS."""
    count = 0
    for pattern in FILLER_PATTERNS:
        count += len(pattern.findall(text))
    return count


# ---------------------------------------------------------------------------
# Per-segment analysis
# ---------------------------------------------------------------------------


def analyze_segment(
    segment: dict,
    audio: np.ndarray,
    sample_rate: int,
) -> dict:
    """
    Analyze one transcript segment.

    Parameters
    ----------
    segment     : dict with keys index, text, tStartMs, tEndMs, speaker
    audio       : full mono waveform array (float32, normalized to [-1, 1])
    sample_rate : samples per second of the loaded audio

    Returns
    -------
    dict with transcriptIndex + audio features
    """
    t_start_ms = segment.get("tStartMs", 0)
    t_end_ms = segment.get("tEndMs", 0)
    text = segment.get("text", "")
    index = segment.get("index", 0)

    # Convert milliseconds to sample indices
    start_sample = int(t_start_ms * sample_rate / 1000)
    end_sample = int(t_end_ms * sample_rate / 1000)

    # Clamp to valid range
    start_sample = max(0, min(start_sample, len(audio)))
    end_sample = max(start_sample, min(end_sample, len(audio)))

    audio_slice = audio[start_sample:end_sample]

    energy = compute_energy(audio_slice)
    silence_ratio = compute_silence_ratio(audio_slice)
    wpm = compute_wpm(text, t_start_ms, t_end_ms)
    filler_count = count_fillers(text)

    result: dict = {
        "transcriptIndex": index,
        "silenceRatio": round(silence_ratio, 4),
        "energy": round(energy, 6),
        "fillerCount": filler_count,
        "provider": "local",
    }

    if wpm is not None:
        result["wpm"] = wpm

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze audio segments and output AudioScore JSON."
    )
    parser.add_argument(
        "--audio",
        required=True,
        help="Path to the audio file (WAV recommended; librosa also reads MP3/WebM).",
    )
    parser.add_argument(
        "--segments-json",
        required=True,
        dest="segments_json",
        help="Path to a JSON file containing an array of TranscriptSegment objects.",
    )
    args = parser.parse_args()

    # Load segments
    try:
        with open(args.segments_json, "r", encoding="utf-8") as f:
            segments: list[dict] = json.load(f)
    except Exception as exc:
        print(f"ERROR: could not read segments file: {exc}", file=sys.stderr)
        sys.exit(1)

    # Load audio — resample to 16 kHz mono for consistent processing
    try:
        audio, sample_rate = librosa.load(args.audio, sr=16_000, mono=True)
    except Exception as exc:
        print(f"ERROR: could not load audio file '{args.audio}': {exc}", file=sys.stderr)
        sys.exit(1)

    # Analyze each segment
    audio_scores = []
    for segment in segments:
        try:
            score = analyze_segment(segment, audio, sample_rate)
            audio_scores.append(score)
        except Exception as exc:
            # Skip failed segments rather than failing the whole batch
            idx = segment.get("index", "?")
            print(
                f"WARNING: skipping segment {idx} due to error: {exc}",
                file=sys.stderr,
            )

    output = {"audioScores": audio_scores}
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
