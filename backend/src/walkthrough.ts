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

/** Estimate mp3 duration from buffer size (OpenAI TTS ~128kbps CBR). */
function getMp3DurationMs(buffer: Buffer): number {
  const bitrate = 128_000;
  return Math.round(((buffer.length * 8) / bitrate) * 1000);
}

function cacheKey(recordingId: Id, kind: WalkthroughKind): string {
  return `walkthrough_${recordingId}_${kind}`;
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
    return { audioUrl: cached.audioUrl, timeline: cached.timeline };
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
  return `You are a sales coach grading a rep's just-finished call.
The rep took this path (in order):
${context}

Write a JSON object with key "script" containing an array of objects, one per path node in the exact order listed above.
Each object must have:
- "nodeId": the exact node ID from the path
- "narration": one short sentence (max ~12 words) grading what happened at that step

Rules:
- Total narration when read aloud must be ~20 seconds (~55 words max across all segments)
- Tone: direct, specific, evidence-based — grade what happened, do not set up future practice
- Quote transcript briefly when provided
- At seller decision points, say whether the choice was good or bad vs sibling EV alternatives
- Return ONLY valid JSON`;
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

async function renderWalkthroughAudio(
  script: ScriptSegment[]
): Promise<{ audio: Buffer; timeline: TimelineCue[] }> {
  const buffers: Buffer[] = [];
  const timeline: TimelineCue[] = [];
  let atMs = 0;

  for (const segment of script) {
    timeline.push({ atMs, nodeId: segment.nodeId });
    const chunk = await synthesizeSegment(segment.narration);
    buffers.push(chunk);
    atMs += getMp3DurationMs(chunk);
  }

  return { audio: Buffer.concat(buffers), timeline };
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

  const { audio, timeline } = await renderWalkthroughAudio(script);

  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const fileName = audioFileName(recording.id, kind);
  await fs.writeFile(join(AUDIO_DIR, fileName), audio);

  const bundle: CachedWalkthrough = {
    audioUrl: audioUrl(recording.id, kind),
    timeline,
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
    .then((bundle) => ({ audioUrl: bundle.audioUrl, timeline: bundle.timeline }))
    .finally(() => {
      generating.delete(inflightKey);
    });

  generating.set(inflightKey, promise);
  return promise;
}
