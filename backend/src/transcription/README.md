# `backend/src/transcription/` — Transcription Providers & Upload Pipeline

This directory contains all speech-to-text adapters used by the CallTree backend. There are two distinct
use-cases, each handled by a different module:

| Use-case | Module | Transport |
|---|---|---|
| **Live call** (two browser tabs, real-time) | `openai.ts` / `deepgram.ts` | WebSocket streaming |
| **MP3 upload** (recorded call file) | `elevenlabs-scribe.ts` | REST (Scribe v2) |

---

## Upload endpoint — end-to-end flow

```
Browser / cURL
  │
  │  POST /upload/call
  │  multipart/form-data:
  │    audio      = <mp3 file>
  │    buyer_name = "Alice Johnson"
  │    company_name = "Acme Corp"
  │
  ▼
server.ts  ─── validates fields, creates IDs ──────────────────────┐
               saves MP3 to:                                        │
               public/data/audio/<recordingId>/call.mp3             │
               creates: Company / Buyer / Call / Tree / Recording   │
               → responds immediately with:                         │
                 { callId, treeId, recordingId }                    │
               kicks off runUploadPipeline() fire-and-forget ───────┘
                 │
                 │  (async, client listens on GET /stream/:recordingId for progress)
                 │
  ┌──────────────▼──────────────────────────────────────────────────────┐
  │                    runUploadPipeline()   upload-pipeline.ts          │
  │                                                                      │
  │  Step 1 — Transcribe                                                 │
  │    elevenlabs-scribe.ts → transcribeWithScribe(audioPath)            │
  │    • Uploads MP3 to ElevenLabs Scribe v2 (diarize=true, 2 speakers) │
  │    • Maps speaker_0 → "seller", speaker_1 → "buyer"                 │
  │    • Returns TranscriptSegment[] with ms timestamps                  │
  │    • Emits SSE: { type:"transcript", segment } for each turn        │
  │                                                                      │
  │  Step 2 — Audio analysis                                             │
  │    LocalAudioAnalyzer → audio_pipeline.py (librosa)                  │
  │    • Per-segment: energy (RMS), silenceRatio, wpm, fillerCount       │
  │    • Returns Map<segmentIndex, AudioScore>                           │
  │    • Falls back silently to empty map on failure                     │
  │                                                                      │
  │  Step 3 — Tree generation                                            │
  │    tree-generator.ts → generateCallTree()                            │
  │    • Reads store._nodeStats (cached win-rate table)                  │
  │    • Calls GPT-4o with transcript + stat table in one shot           │
  │    • GPT returns: realPath[] + branches[]                            │
  │    • assembleTree() wires nodes with IDs, parent/child links,        │
  │      signal metrics from audio scores                                │
  │    • Emits SSE: { type:"move" } and { type:"metrics" } per node     │
  │                                                                      │
  │  Step 4 — Persist + feedback                                         │
  │    • Saves tree + recording traversal to seed.json                   │
  │    • Generates post-call feedback via buildAiFeedback()              │
  │    • Calls refreshStatCache() → folds new call into win-rate table   │
  │                                                                      │
  │  Step 5 — Done                                                       │
  │    • Emits SSE: { type:"processing", status:"done" }                 │
  └──────────────────────────────────────────────────────────────────────┘
```

All SSE progress events are keyed to `recordingId`. Connect to `GET /stream/:recordingId` *before*
uploading (or immediately after) and you will receive the full event stream.

---

## `elevenlabs-scribe.ts`

**Only module used by the upload pipeline.** Not used by live sessions at all.

```typescript
export async function transcribeWithScribe(audioPath: string): Promise<TranscriptSegment[]>
```

- Reads the MP3 from disk and POSTs it to `https://api.elevenlabs.io/v1/speech-to-text`
- Request params: `model_id=scribe_v2`, `diarize=true`, `num_speakers=2`
- ElevenLabs returns a `words[]` array with `speaker_id` on each word token
- **Speaker mapping**: the first `speaker_id` seen → `"seller"`, the next → `"buyer"`
  - This relies on the product guarantee that **the seller always speaks first**
  - If the guarantee is violated, seller/buyer labels will be swapped for the entire recording
- Consecutive words from the same speaker are merged into a single `TranscriptSegment`
- Non-word tokens (`spacing`, `audio_event`) are discarded

**Required env var:** `ELEVENLABS_API_KEY` — must be set in `backend/.env`.

---

## `tree-generator.ts` (not in this folder, but called by the pipeline)

Located at `backend/src/tree-generator.ts`. Does all GPT-4o work.

### Node win-rate stat cache

The key ingredient that makes AI branches data-driven rather than hallucinated:

```
store._nodeStats: NodeStatEntry[]
  { title, wins, losses, winRate, sampleSize }
```

- Built by `buildNodeStatTable()` — scans every resolved call in `seed.json`
- Win rate is Beta-smoothed: `(wins + 1) / (wins + losses + 2)` — prevents 0%/100% from tiny samples
- Stored back in `seed.json` under `_nodeStats` (survives server restarts)
- Rebuilt at server startup if the field is missing
- Refreshed automatically after every upload pipeline finishes

The stat table is injected verbatim into the GPT-4o prompt. GPT is instructed to:
1. Anchor `successProbability` to matching node titles in the table
2. Target the highest win-rate paths for AI branch suggestions
3. Match node titles to historical entries via fuzzy matching

### GPT-4o output shape

```json
{
  "realPath": [
    { "title": "...", "description": "...", "speaker": "seller|buyer",
      "successProbability": 0.72, "transcriptIndices": [0, 1, 2] }
  ],
  "branches": [
    {
      "parentRealPathIndex": 2,
      "nodes": [
        { "title": "...", "description": "...", "speaker": "seller", "successProbability": 0.85 },
        { "title": "...", "description": "...", "speaker": "buyer",  "successProbability": 0.90 }
      ]
    }
  ]
}
```

`transcriptIndices` links each real-path node back to the original `TranscriptSegment[]` so
`metricsForSegments()` can compute confidence/hesitation/enthusiasm from real audio data.
AI branch nodes have no real audio — their metrics are derived synthetically from `successProbability`.

---

## Live call modules (not part of upload flow)

| File | Purpose |
|---|---|
| `provider.ts` | `SpeakerStream` + `TranscriptionProvider` interfaces |
| `openai.ts` | OpenAI Realtime streaming STT (`OpenAIProvider`) — default |
| `deepgram.ts` | Stub placeholder; swap via `TRANSCRIPTION_PROVIDER=deepgram` |
| `index.ts` | Factory: `createProvider(recordingId)` reads env var |

These are only used by `WS /live/session/:recordingId` (`live.ts`). The upload endpoint (`POST /upload/call`) does **not** use them.

---

## Testing the upload pipeline

### With the debug page

Open `frontend/test-UIs/debug-upload.html` directly in Chrome (no build step). It:
- Submits the form to `POST /upload/call`
- Connects to the SSE stream automatically
- Renders pipeline step progress, the full SSE event log, the generated tree, and the node stat table

### With cURL

```bash
# Start backend first: cd backend && npm run dev

# Upload a call
curl -X POST http://localhost:3001/upload/call \
  -F "audio=@/path/to/call.mp3" \
  -F "buyer_name=Alice Johnson" \
  -F "company_name=Acme Corp"

# Response: { "callId": "...", "treeId": "...", "recordingId": "rec_..." }

# Stream progress (open in separate terminal before uploading for best effect)
curl -N http://localhost:3001/stream/<recordingId>

# Inspect node stat cache
curl http://localhost:3001/_debug/node-stats
```

### Required env vars (both must be set)

```bash
OPENAI_API_KEY=sk-...          # GPT-4o tree generation
ELEVENLABS_API_KEY=sk_...      # Scribe v2 transcription
PYTHON_BIN=.../.venv/Scripts/python.exe   # librosa audio analysis
AUDIO_ANALYZER_TIMEOUT_MS=30000
```

---

## Adding a new transcription provider for uploads

1. Create `backend/src/transcription/your-provider.ts`
2. Export an async function: `transcribeWithYourProvider(audioPath: string): Promise<TranscriptSegment[]>`
3. Import and call it from `upload-pipeline.ts` in place of `transcribeWithScribe`

The `TranscriptSegment` contract is:
```typescript
interface TranscriptSegment {
  index: number;          // 0-based, sequential
  speaker: "seller" | "buyer";
  text: string;
  tStartMs: number;       // milliseconds from start of recording
  tEndMs: number;
}
```
