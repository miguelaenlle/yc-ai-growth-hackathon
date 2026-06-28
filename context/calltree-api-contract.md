# CallTree — API Contract (final)

Definitive, self-contained contract. Types in §2, endpoints in §3, the live event stream in §4. Examples reference the records in `calltree-seed.json`, so every request/response pair is real. Supersedes earlier API drafts.

## 1. Conventions

- **Base URL:** `http://localhost:3001`
- **Format:** JSON in/out, except `POST /transcribe` (multipart) and `GET /stream/:id` (SSE).
- **IDs:** opaque strings (`call_convex`, `n_push`, `rec_real`).
- **Errors:** `{ "error": { "code": string, "message": string } }` with the matching HTTP status (`400` bad input, `404` not found, `500` server).
- **Deal value:** Convex is a $48,000 deal; `expectedValue = round(successProbability * 48000)`.

## 2. Types

```ts
type Id = string;

// ---------- Persisted entities ----------
interface Company     { id: Id; name: string; buyers: Buyer[]; }
interface Buyer       { id: Id; name: string; title: string; }
interface Salesperson { id: Id; name: string; title: string; }

interface Call {
  id: Id;
  companyId: Id;
  salespersonId: Id;
  buyerId: Id;
  startedAt: string;          // ISO 8601
  treeId: Id;
  recordingIds: Id[];
}

interface Tree { id: Id; callId: Id; rootNodeId: Id; nodes: TreeNode[]; }

interface TreeNode {
  id: Id;
  parentId: Id | null;
  childIds: Id[];
  title: string;              // "Pushback"
  description: string;        // "You don't have Tableau integration"
  speaker: "seller" | "buyer";
  tMs: number;                // offset into the call this moment occurred
  successProbability: number; // 0..1   → green↔red spectrum
  expectedValue: number;      // currency
  metrics: SignalMetrics;
}

interface SignalMetrics { confidence: number; hesitation: number; enthusiasm: number; } // each 0..1

interface Recording {
  id: Id;
  callId: Id;
  treeId: Id;
  isReal: boolean;            // true = actual call; false = a mock
  isActive: boolean;          // currently in progress (live)
  startNodeId: Id | null;     // mock: where practice begins (null = root)
  stopNodeId: Id | null;      // mock: breakpoint to stop at
  audioPath: string;
  lengthMs: number;
  transcript: TranscriptSegment[];
  traversal: Traversal;
  aiNotes: AiNotes | null;        // live intel
  aiFeedback: AiFeedback | null;  // post-call review
}

interface TranscriptSegment { index: number; speaker: "seller"|"buyer"; text: string; tStartMs: number; tEndMs: number; }
interface Traversal     { initialNodeId: Id; finalNodeId: Id; steps: TraversalStep[]; }
interface TraversalStep { transcriptIndex: number; fromNodeId: Id; toNodeId: Id; tMs: number; }

interface AiNotes { commitments: string[]; objections: string[]; facts: string[]; suggestions: string[]; }
interface PracticeTarget { nodeId: Id; reason: string; drill: string; metric: keyof SignalMetrics; score: number; }
interface AiFeedback { summary: string; strengths: string[]; weaknesses: string[]; practiceTargets: PracticeTarget[]; }

// ---------- Derived / transport (not persisted) ----------
interface CallSummary { id: Id; company: string; startedAt: string; outcome: "won"|"lost"|"open"; bestEV: number; }
interface CallDetail  { call: Call; tree: Tree; recordings: Recording[]; company: Company; buyer: Buyer; salesperson: Salesperson; }
interface TimelineCue { atMs: number; nodeId: Id; }
interface WalkthroughBundle { audioUrl: string; timeline: TimelineCue[]; }

type LiveEvent =
  | { type: "transcript"; segment: TranscriptSegment }
  | { type: "move";       step: TraversalStep; node: TreeNode }
  | { type: "branch";     node: TreeNode }
  | { type: "metrics";    nodeId: Id; metrics: SignalMetrics }
  | { type: "notes";      notes: AiNotes };

// ---------- Request bodies ----------
interface StartRecordingReq { callId: Id; isReal: boolean; startNodeId?: Id; stopNodeId?: Id; }
interface AppendReq         { segments: TranscriptSegment[]; steps?: TraversalStep[]; }
interface BranchReq         { recordingId: Id; currentNodeId: Id; utterance: string; }
interface MockTurnReq       { recordingId: Id; role: "buyer"|"seller"|"both"; currentNodeId: Id; }
interface NotesReq          { window: TranscriptSegment[]; }
interface TtsReq            { text: string; voiceId: string; }
interface CreateCallReq     { companyId: Id; salespersonId: Id; buyerId: Id; startedAt: string; audioPath?: string; }
```

## 3. Endpoints

### A · Browse & read

**1. `GET /calls?last=N&scope=me|team&companyId=` → `CallSummary[]`**
Filter calls; per call derive `outcome` (from the real recording's final node) and `bestEV` (max node EV). Sort by `startedAt` desc, slice to `last`.
```json
[ { "id": "call_convex", "company": "Convex", "startedAt": "2026-06-25T17:00:00-07:00", "outcome": "lost", "bestEV": 45600 } ]
```

**2. `GET /calls/:id` → `CallDetail`**
Load call, its tree, and all its recordings, plus the resolved `company`, `buyer`, and `salesperson` for the call (looked up by `companyId`/`buyerId`/`salespersonId`). (Body = the full seed objects for `call_convex`, `tree_convex`, `rec_real`, `rec_mock1`, plus `co_convex`, `buy_john`, `sp_jane`.)

**3. `GET /trees/:id` → `Tree`**
Return the tree file.

**4. `GET /recordings/:id` → `Recording`**
Return the recording file.

### B · Recording lifecycle

**5. `POST /calls` (`CreateCallReq`) → `{ callId, treeId, recordingId }`**
Create a `Call`, an empty `Tree` (one root node), and a real `Recording` (`isActive:true`). Kick off processing async; return ids immediately.
```json
{ "callId": "call_a1b2", "treeId": "tree_a1b2", "recordingId": "rec_a1b2" }
```

**6. `POST /recordings` (`StartRecordingReq`) → `{ recordingId }`**
Create a recording on the call's tree, `isActive:true`, `traversal.initialNodeId = startNodeId ?? rootNodeId`, store `stopNodeId`. Client then opens the SSE stream.
```json
// req
{ "callId": "call_convex", "isReal": false, "startNodeId": "n_push", "stopNodeId": "n_agree" }
// res
{ "recordingId": "rec_mock_demo" }
```

**7. `PATCH /recordings/:id` (`AppendReq`) → `202 { ok, currentNodeId }`**
Append segments. Run the Tree Engine to confirm/derive `steps` (matching a child, or calling `/agent/branch` if off-tree). Run the Signal Engine to write node `metrics`. Emit the matching `LiveEvent`s. Persist.
```json
{ "ok": true, "currentNodeId": "n_push" }
```

**8. `POST /recordings/:id/feedback` → `AiFeedback`**
Build the review from transcript + node metrics (LLM). Independently scan the path for weak nodes (`hesitation` high / `confidence` low), rank by `score`, emit one `PracticeTarget` each. Persist into `recording.aiFeedback`.
```json
{
  "summary": "You surfaced strong pain quickly, but the Tableau objection turned the call...",
  "strengths": ["Warm, low-friction open", "Surfaced a real pain within two minutes"],
  "weaknesses": ["Hesitated when the Tableau objection landed", "Answered a present-day gap with a future promise"],
  "practiceTargets": [
    { "nodeId": "n_push", "reason": "Confidence dropped and hesitation spiked when the objection landed", "drill": "Acknowledge the gap, then pivot to value", "metric": "hesitation", "score": 0.71 },
    { "nodeId": "n_road", "reason": "Answered the gap with a roadmap promise", "drill": "Reframe to the SQL-connector workaround", "metric": "confidence", "score": 0.31 }
  ]
}
```

**9. `GET /recordings/:id/walkthrough?kind=intro|review` → `WalkthroughBundle`**
One engine, two prompts. `intro` = path up to `startNodeId` (context before a mock); `review` = whole path (what went well / what didn't). Build `script` (LLM) + `timeline` (from `traversal.steps[].tMs`), render `script` via `/tts`, return `{ audioUrl, timeline }`.
```json
{
  "audioUrl": "/data/audio/walkthrough_rec_real_review.mp3",
  "timeline": [
    { "atMs": 0, "nodeId": "n_open" }, { "atMs": 6000, "nodeId": "n_disc" },
    { "atMs": 12000, "nodeId": "n_push" }, { "atMs": 18000, "nodeId": "n_road" }, { "atMs": 24000, "nodeId": "n_lost" }
  ]
}
```

### C · Realtime & agents

**10. `GET /stream/:recordingId` (SSE) → `LiveEvent` stream**
One-way server→client. `Content-Type: text/event-stream`; each event is `data: {LiveEvent}\n\n`. Heartbeat `: ping\n\n` every ~15s. On reconnect, replay events newer than `Last-Event-ID`. See §4.

**11. `POST /transcribe` (multipart: `audio`, `recordingId`, `tStartMs`) → `{ segments: TranscriptSegment[] }`**
Forward audio to Whisper, offset timestamps by `tStartMs`, continue `index` from the recording's transcript length.
```json
{ "segments": [ { "index": 4, "speaker": "buyer", "text": "You don't have Tableau integration...", "tStartMs": 23000, "tEndMs": 31000 } ] }
```

**12. `POST /agent/notes` (`NotesReq`) → `AiNotes`**
LLM extracts commitments / objections / facts / suggestions from the window. Merge into `recording.aiNotes`; emit a `notes` event.
```json
{ "commitments": [], "objections": ["No Tableau integration"], "facts": ["Analytics team standardized on Tableau"], "suggestions": ["Offer SQL connectors as a bridge"] }
```

**13. `POST /agent/branch` (`BranchReq`) → `{ node: TreeNode } | { node: null, matchedNodeId: Id }`**
Add a node **only when the utterance is significantly different from existing decision nodes** — the similarity threshold is the throttle; don't grow the tree on rephrasings.
- Score `utterance` against the plausible existing decision nodes (current node's children first, then near siblings) via embedding cosine or an LLM 0–1 judgment.
- **Above threshold** (≈0.8): return `{ node: null, matchedNodeId }`. Create nothing.
- **Below threshold** (a real new fork): create one `TreeNode`, `parentId = currentNodeId`, seed `successProbability`/`expectedValue`, persist, emit a `branch` event. One node per call — never a subtree.
```json
// req
{ "recordingId": "rec_real", "currentNodeId": "n_push", "utterance": "What about a Looker integration instead?" }
// res
{ "node": { "id": "n_looker", "parentId": "n_push", "childIds": [], "title": "Looker ask", "description": "What about Looker instead?", "speaker": "buyer", "tMs": 49000, "successProbability": 0.40, "expectedValue": 19200, "metrics": { "confidence": 0, "hesitation": 0, "enthusiasm": 0 } } }
```

**14. `WS /mock/session/:recordingId?currentNodeId=...&includePrecap=true`**
WebSocket endpoint connecting the frontend to the backend for the mock practice session.
The session has two phases:
1. **Precap (Optional)**: If `includePrecap=true`, the backend streams an audio intro (context of what happened so far) down the WebSocket. It sends `{ "type": "precap_node", "nodeId": "..." }` events right before sending the corresponding `{ "type": "precap_audio", "b64_data": "..." }` chunks, allowing the FE to animate the tree in sync. When finished, it sends `{ "type": "precap_complete" }`.
2. **Interactive Mock**: The backend connects to the OpenAI Realtime API. It proxies bidirectional audio and events (like `response.audio.delta` and `input_audio_buffer.append`). The transcript and tree progression are tracked in real-time.

**15. `POST /tts` (`TtsReq`) → `{ audioUrl }`**
Proxy `text`+`voiceId` to ElevenLabs (key stays server-side), save under `/data/audio/`, return the URL. Cache by `hash(text+voiceId)`. Separate from SSE because audio is a binary pull the `<audio>` element streams/seeks/caches from a URL — not a text push.
```json
{ "audioUrl": "/data/audio/tts_8f2a1c.mp3" }
```

## 4. SSE event stream

`GET /stream/:recordingId` emits one `LiveEvent` per `data:` frame. The five variants drive the whole live screen: `move`/`branch` → the tree, `metrics` → the meters, `notes` → the intel panel, `transcript` → the caption rail.

```
data: {"type":"transcript","segment":{"index":4,"speaker":"buyer","text":"You don't have Tableau integration","tStartMs":23000,"tEndMs":31000}}

data: {"type":"move","step":{"transcriptIndex":4,"fromNodeId":"n_disc","toNodeId":"n_push","tMs":23000},"node":{"id":"n_push","title":"Pushback","speaker":"buyer"}}

data: {"type":"metrics","nodeId":"n_push","metrics":{"confidence":0.34,"hesitation":0.71,"enthusiasm":0.30}}

data: {"type":"notes","notes":{"commitments":[],"objections":["No Tableau integration"],"facts":["Analytics team uses Tableau"],"suggestions":["Offer SQL connectors"]}}
```

## 5. Endpoint summary

| # | Method | Path | In | Out |
|---|---|---|---|---|
| 1 | GET | `/calls` | query | `CallSummary[]` |
| 2 | GET | `/calls/:id` | — | `CallDetail` |
| 3 | GET | `/trees/:id` | — | `Tree` |
| 4 | GET | `/recordings/:id` | — | `Recording` |
| 5 | POST | `/calls` | `CreateCallReq` | `{callId,treeId,recordingId}` |
| 6 | POST | `/recordings` | `StartRecordingReq` | `{recordingId}` |
| 7 | PATCH | `/recordings/:id` | `AppendReq` | `{ok,currentNodeId}` |
| 8 | POST | `/recordings/:id/feedback` | — | `AiFeedback` |
| 9 | GET | `/recordings/:id/walkthrough` | `?kind` | `WalkthroughBundle` |
| 10 | GET | `/stream/:recordingId` | — | SSE `LiveEvent` |
| 11 | POST | `/transcribe` | multipart | `{segments}` |
| 12 | POST | `/agent/notes` | `NotesReq` | `AiNotes` |
| 13 | POST | `/agent/branch` | `BranchReq` | `{node}` / `{node:null,matchedNodeId}` |
| 14 | WS | `/mock/session/:recordingId` | `Audio Stream` | `Audio Stream` |
| 15 | POST | `/tts` | `TtsReq` | `{audioUrl}` |
