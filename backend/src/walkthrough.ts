import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  getDecisionAlternatives,
  getDecisionSummary,
  getPathFromTraversal,
} from "./tree-ops.js";
import { getTree } from "./store.js";
import type {
  Id,
  Recording,
  TimelineCue,
  Tree,
  TreeNode,
  WalkthroughBundle,
  WalkthroughSegment,
} from "./types.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "data", "cache");
const AUDIO_DIR = join(__dirname, "..", "public", "data", "audio");

type WalkthroughKind = "intro" | "review";

interface ScriptSegment {
  nodeId: Id;
  narration: string;
}

interface CachedWalkthrough extends WalkthroughBundle {
  script?: ScriptSegment[];
}

/** Estimate mp3 duration from buffer size. OpenAI tts-1 mp3 is 160 kbps CBR
 *  (verified via afinfo); using 128k over-estimated duration by ~25%, which
 *  spaced the timeline cues too wide — node highlights lagged the narration and
 *  the final cue landed past the end of the audio. */
function getMp3DurationMs(buffer: Buffer): number {
  const bitrate = 160_000;
  return Math.round(((buffer.length * 8) / bitrate) * 1000);
}

const CACHE_VERSION = "v2";

function cacheKey(recordingId: Id, kind: WalkthroughKind): string {
  return `walkthrough_${CACHE_VERSION}_${recordingId}_${kind}`;
}

function cacheJsonPath(recordingId: Id, kind: WalkthroughKind): string {
  return join(CACHE_DIR, `${cacheKey(recordingId, kind)}.json`);
}

function audioFileName(recordingId: Id, kind: WalkthroughKind): string {
  return `${cacheKey(recordingId, kind)}.mp3`;
}

function audioUrl(recordingId: Id, kind: WalkthroughKind): string {
  return `/data/audio/${audioFileName(recordingId, kind)}`;
}

async function readCache(
  recordingId: Id,
  kind: WalkthroughKind
): Promise<WalkthroughBundle | null> {
  try {
    const jsonPath = cacheJsonPath(recordingId, kind);
    const audioPath = join(AUDIO_DIR, audioFileName(recordingId, kind));
    const [jsonRaw] = await Promise.all([
      fs.readFile(jsonPath, "utf-8"),
      fs.access(audioPath),
    ]);
    const cached = JSON.parse(jsonRaw) as CachedWalkthrough;
    return { audioUrl: cached.audioUrl, timeline: cached.timeline, segments: cached.segments };
  } catch {
    return null;
  }
}

async function writeCache(
  recordingId: Id,
  kind: WalkthroughKind,
  bundle: CachedWalkthrough
): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheJsonPath(recordingId, kind), JSON.stringify(bundle, null, 2));
}

function transcriptForNode(
  recording: Recording,
  node: TreeNode
): string | undefined {
  const step = recording.traversal.steps.find((s) => s.toNodeId === node.id);
  if (!step) return undefined;
  const seg = recording.transcript[step.transcriptIndex];
  return seg?.text;
}

function buildReviewContext(tree: Tree, recording: Recording): string {
  const path = getPathFromTraversal(tree, recording.traversal);
  const pathIds = new Set(path.map((n) => n.id));
  const lines: string[] = [];

  for (const node of path) {
    const transcript = transcriptForNode(recording, node);
    const alt = getDecisionAlternatives(tree, node.id, pathIds);
    lines.push(
      `NODE ${node.id} | ${node.speaker.toUpperCase()} | "${node.title}" | ${node.description}`,
      `  EV: $${node.expectedValue.toLocaleString()} (${Math.round(node.successProbability * 100)}% win)`,
      `  Signals: confidence=${node.metrics.confidence.toFixed(2)}, hesitation=${node.metrics.hesitation.toFixed(2)}, enthusiasm=${node.metrics.enthusiasm.toFixed(2)}`
    );
    if (transcript) {
      lines.push(`  Transcript: "${transcript}"`);
    }
    if (alt.length > 0) {
      lines.push(
        "  Alternatives not taken:",
        ...alt.map(
          (a) =>
            `    - ${a.id} "${a.title}": EV $${a.expectedValue.toLocaleString()} (${Math.round(a.successProbability * 100)}% win)`
        )
      );
    }
  }

  return lines.join("\n");
}

function buildIntroContext(tree: Tree, endNodeId: Id): string {
  const summary = getDecisionSummary(tree, endNodeId);
  return summary.path
    .map(
      (n) =>
        `ID: ${n.id} | ${n.speaker.toUpperCase()} SAID: ${n.description}`
    )
    .join("\n");
}

function reviewPrompt(context: string): string {
  return `You are a sales coach giving a brief spoken debrief right after a rep finished a call. Write the way you'd actually talk — one continuous review, not a checklist or report card.

Call path and evidence:
${context}

Return JSON: { "script": [{ "nodeId": "<exact node id>", "narration": "<spoken phrase>" }, ...] }

Requirements:
- Exactly one entry per path node, in the order listed above.
- Keep it SNAPPY. Each node's narration is ONE short sentence, 8–14 words — a hard limit, do not exceed. The whole thing should read as a tight ~15-second monologue (~45–60 words total) that moves quickly node to node. Each segment hands off naturally to the next — use connectors like "From there", "But when", "That left you with", "So".
- Example flow (do not copy verbatim): "Clean open — you got Sarah talking fast." → "Good discovery, you had her engaged." → "Then she raised Teams, and instead of reframing you knocked it." → "That made her defensive — the coexistence pitch was a forty-two-K path you skipped." → "She checked out. Deal lost."
- Grade what happened: strengths, mistakes, and at seller forks whether the choice beat the EV of alternatives. Quote transcript briefly when provided.
- Avoid staccato labels ("Good opening.", "Weak response.") — keep it conversational.
- Do not assign homework or future practice — only grade this call.
- Return ONLY valid JSON.`;
}

function introPrompt(context: string): string {
  return `You are a narrator summarizing a sales call up to this point.
The conversation path is:
${context}

Return a JSON object with a single key "script" containing an array of objects, one for each node in the exact order above.
Each object must have:
- "nodeId": the exact ID of the node
- "narration": A brief, natural, 1-2 sentence narration of what happened at this step`;
}

async function generateScript(
  prompt: string
): Promise<ScriptSegment[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const llmRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });

  if (!llmRes.ok) {
    throw new Error(`LLM walkthrough failed: ${await llmRes.text()}`);
  }

  const llmData = (await llmRes.json()) as {
    choices: { message: { content: string } }[];
  };
  const parsed = JSON.parse(llmData.choices[0].message.content) as {
    script?: ScriptSegment[];
  };
  return parsed.script ?? [];
}

async function synthesizeSegment(text: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: "alloy",
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    throw new Error(`TTS failed: ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Render ONE TTS clip per node. Per-node clips are what make summarize sync exact:
 * the frontend decodes each clip's true duration (Web Audio) and schedules them
 * gaplessly, so a node lights up precisely when its line begins — no
 * char-count/bitrate estimation anywhere. We also concatenate the clips into a
 * single file + cue timeline as a fallback for the old playback path.
 */
async function renderWalkthroughAudio(
  recordingId: Id,
  kind: WalkthroughKind,
  script: ScriptSegment[]
): Promise<{ audio: Buffer; timeline: TimelineCue[]; segments: WalkthroughSegment[] }> {
  const key = cacheKey(recordingId, kind);
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  const clips = await Promise.all(
    script.map((s) => synthesizeSegment(s.narration.trim())),
  );

  const segments: WalkthroughSegment[] = [];
  const timeline: TimelineCue[] = [];
  let atMs = 0;
  for (let i = 0; i < script.length; i++) {
    const clipName = `${key}_${i}.mp3`;
    await fs.writeFile(join(AUDIO_DIR, clipName), clips[i]);
    segments.push({ nodeId: script[i].nodeId, audioUrl: `/data/audio/${clipName}` });
    timeline.push({ atMs, nodeId: script[i].nodeId });
    atMs += getMp3DurationMs(clips[i]);
  }

  // Gapless single render for the fallback path (mp3 frames concatenate cleanly).
  const audio = Buffer.concat(clips);
  return { audio, timeline, segments };
}

async function generateWalkthrough(
  recording: Recording,
  tree: Tree,
  kind: WalkthroughKind
): Promise<CachedWalkthrough> {
  const context =
    kind === "review"
      ? buildReviewContext(tree, recording)
      : buildIntroContext(
          tree,
          recording.startNodeId ??
            recording.traversal.finalNodeId ??
            tree.rootNodeId
        );

  const prompt = kind === "review" ? reviewPrompt(context) : introPrompt(context);
  console.log(`[Walkthrough] Generating ${kind} for ${recording.id}…`);
  const script = await generateScript(prompt);

  if (script.length === 0) {
    throw new Error("LLM returned empty walkthrough script");
  }

  const { audio, timeline, segments } = await renderWalkthroughAudio(recording.id, kind, script);

  const fileName = audioFileName(recording.id, kind);
  await fs.writeFile(join(AUDIO_DIR, fileName), audio);

  const bundle: CachedWalkthrough = {
    audioUrl: audioUrl(recording.id, kind),
    timeline,
    segments,
    script,
  };

  await writeCache(recording.id, kind, bundle);
  console.log(`[Walkthrough] Cached ${kind} for ${recording.id}`);
  return bundle;
}

/**
 * Return a cached walkthrough bundle, generating and persisting on cache miss.
 * Concurrent requests for the same recording/kind share one in-flight generation.
 */
const generating = new Map<string, Promise<WalkthroughBundle>>();

export async function getOrBuildWalkthrough(
  recording: Recording,
  kind: WalkthroughKind
): Promise<WalkthroughBundle> {
  const inflightKey = `${recording.id}:${kind}`;

  const cached = await readCache(recording.id, kind);
  if (cached) {
    console.log(`[Cache Hit] walkthrough ${recording.id} ${kind}`);
    return cached;
  }

  const pending = generating.get(inflightKey);
  if (pending) {
    console.log(`[Cache Wait] walkthrough ${recording.id} ${kind} (in flight)`);
    return pending;
  }

  const tree = getTree(recording.treeId);
  if (!tree) throw new Error(`tree ${recording.treeId} not found`);

  const promise = generateWalkthrough(recording, tree, kind)
    .then((bundle) => ({ audioUrl: bundle.audioUrl, timeline: bundle.timeline, segments: bundle.segments }))
    .finally(() => {
      generating.delete(inflightKey);
    });

  generating.set(inflightKey, promise);
  return promise;
}
