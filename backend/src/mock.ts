import WebSocket from "ws";
import {
  bestMatch,
  getDecisionAlternatives,
  getDecisionSummary,
  getNodeById,
  getNodeChildren,
} from "./tree-ops.js";
import { getRecording, getTree, store } from "./store.js";
import type { Id, Recording, Tree, TranscriptSegment, TreeNode } from "./types.js";

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "data", "cache");

import { getPersonaInfo } from "./personas.js";
import { getProductInfo } from "./product.js";

function generateMockPrompt(
  recordingId: Id,
  currentNodeId: Id,
  personaId: Id = "buy_polly",
): string {
  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;

  const productInfo = rec ? getProductInfo(rec.callId) : getProductInfo("co_slack");
  const personaInfo = getPersonaInfo(personaId);

  let pathContext = "No prior context.";
  let branchRules = "";
  if (tree && currentNodeId) {
    try {
      const summary = getDecisionSummary(tree, currentNodeId);
      pathContext = summary.path.map(n => `[${n.speaker.toUpperCase()}]: ${n.description}`).join("\n");
    } catch (e) {
      console.warn("Could not get decision summary, using fallback");
    }

    const current = tree.nodes.find(n => n.id === currentNodeId);
    if (current) {
      const children = current.childIds.map(id => tree.nodes.find(n => n.id === id)).filter(Boolean) as any[];
      if (children.length > 0) {
        branchRules = "\nEXPECTED NEXT STEPS (Use these as a guide for how to evaluate the seller's response and what to say next):\n";
        for (const child of children) {
          branchRules += `- If the seller's response maps to "${child.title}" (${child.description}):\n`;
          const grandchildren = child.childIds.map((id: Id) => tree.nodes.find(n => n.id === id)).filter(Boolean) as any[];
          const buyerResponses = grandchildren.filter((n: any) => n.speaker === "buyer");
          if (buyerResponses.length > 0) {
            const options = buyerResponses.map((r: any) => `"${r.description}"`).join(" OR ");
            branchRules += `  -> You MUST respond with something similar to one of these: ${options}\n`;
          } else {
            branchRules += `  -> Respond naturally to their point as a skeptical buyer.\n`;
          }
        }
        branchRules += `- If they don't say any of these, respond naturally to their point.\n`;
      }
    }
  }

  return `
You are simulating a sales call from the perspective of the buyer. 
You will speak with a seller (the user) who is trying to sell you a product.

PRODUCT CONTEXT:
${productInfo}

YOUR PERSONA:
${personaInfo}

CONVERSATION SO FAR:
${pathContext}
${branchRules}

INSTRUCTIONS:
1. Stay strictly in character as the buyer. 
2. Keep your responses conversational, concise, and realistic. 
3. Do not break character or acknowledge that you are an AI.
4. Respond directly to the user's audio input.
`;
}

async function handlePrecapPhase(clientWs: WebSocket, recordingId: Id, currentNodeId: Id) {
  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;
  if (!tree || !currentNodeId) {
    clientWs.send(JSON.stringify({ type: "precap_complete" }));
    return;
  }

  const cachePath = join(CACHE_DIR, `precap_${currentNodeId}.json`);
  try {
    const cached = await fs.readFile(cachePath, "utf-8");
    const script = JSON.parse(cached);
    console.log(`[Cache Hit] Loaded precap for ${currentNodeId}`);
    clientWs.send(JSON.stringify({ type: "info", text: `Loaded TTS from local cache for node ${currentNodeId}` }));
    for (const chunk of script) {
      if (chunk.type === "precap_node") {
        clientWs.send(JSON.stringify({ type: "precap_node", nodeId: chunk.nodeId }));
      } else if (chunk.type === "precap_audio") {
        clientWs.send(JSON.stringify({ type: "precap_audio", b64_data: chunk.b64_data }));
      }
    }
    clientWs.send(JSON.stringify({ type: "precap_complete" }));
    return;
  } catch (e) {
    // Cache miss — generate fresh
  }

  try {
    const summary = getDecisionSummary(tree, currentNodeId);

    const promptText = `
You are a narrator summarizing a sales call up to this point. 
The conversation path is:
${summary.path.map(n => `ID: ${n.id} | ${n.speaker.toUpperCase()} SAID: ${n.description}`).join("\n")}

Return a JSON object with a single key "script" containing an array of objects, one for each node in the exact order above. 
Each object must have:
- "nodeId": the exact ID of the node.
- "narration": A brief, natural, 1-2 sentence narration of what happened at this step.
`;

    const llmRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: promptText }],
        response_format: { type: "json_object" },
      }),
    });

    if (!llmRes.ok) {
      console.error("LLM Precap failed:", await llmRes.text());
      clientWs.send(JSON.stringify({ type: "precap_complete" }));
      return;
    }

    const llmData = (await llmRes.json()) as {
      choices: { message: { content: string } }[];
    };
    const parsed = JSON.parse(llmData.choices[0].message.content);
    const script = parsed.script || [];

    const cacheData: any[] = [];

    for (const chunk of script) {
      clientWs.send(JSON.stringify({ type: "precap_node", nodeId: chunk.nodeId }));
      cacheData.push({ type: "precap_node", nodeId: chunk.nodeId });

      const text = chunk.narration;
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice: "alloy",
          response_format: "opus",
        }),
      });

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const b64_data = Buffer.from(arrayBuffer).toString("base64");
        clientWs.send(JSON.stringify({ type: "precap_audio", b64_data }));
        cacheData.push({ type: "precap_audio", b64_data });
      } else {
        console.error("TTS failed:", await response.text());
      }
    }

    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(cacheData));
      console.log(`[Cache Write] Saved precap for ${currentNodeId}`);
    } catch (e) {
      console.error("Failed to write cache:", e);
    }
  } catch (e) {
    console.error("Error during precap:", e);
  }

  clientWs.send(JSON.stringify({ type: "precap_complete" }));
}

/**
 * Mock routing: decide which EXISTING child of `currentNodeId` the latest
 * utterance lands on. Unlike the real-call flow, this NEVER creates a node — in
 * practice mode we constrain the conversation to the authored tree.
 *
 * Primary path: ask gpt-4o-mini to classify the utterance into one of the child
 * options (or "none" → stay). Fallback (no key / error): highest Jaccard token
 * overlap among the children. Returns the chosen child id, or null to stay put
 * (no confident match, or `currentNodeId` is a leaf so the conversation ends).
 */
async function chooseExistingChild(
  tree: Tree,
  currentNodeId: Id,
  utterance: string,
): Promise<Id | null> {
  const children = getNodeChildren(tree, currentNodeId);
  if (children.length === 0) return null; // leaf — the call plays out / ends
  if (children.length === 1) return children[0].id; // only one way forward

  const apiKey = process.env.OPENAI_API_KEY;
  const text = utterance.trim();

  if (apiKey && text) {
    const options = children
      .map((c, i) => `${i + 1}. [${c.title}] ${c.description}`)
      .join("\n");
    const prompt =
      `A sales conversation is at a decision point. The speaker just said:\n` +
      `"${text}"\n\n` +
      `Which ONE of these possible next moves best matches what they said?\n` +
      `${options}\n\n` +
      `Reply with JSON {"choice": <number>} — the option number ` +
      `(1-${children.length}), or 0 if none of them fit.`;
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        const choice = Number(
          JSON.parse(data.choices[0].message.content)?.choice,
        );
        if (Number.isInteger(choice) && choice >= 1 && choice <= children.length) {
          return children[choice - 1].id;
        }
        if (choice === 0) return null; // model says nothing fits → stay
      } else {
        console.error("[mock route] LLM failed:", await res.text());
      }
    } catch (e) {
      console.error("[mock route] LLM error:", e);
    }
  }

  // Fallback: closest child by token overlap. No threshold — we never create
  // here, so advancing to the nearest authored branch is the safe default.
  const match = bestMatch(tree, currentNodeId, text);
  return match ? match.nodeId : null;
}

export async function handleMockSession(
  clientWs: WebSocket,
  recordingId: Id,
  currentNodeId: Id,
  includePrecap: boolean,
  maxDepth?: number,
  targetNodeIds: string[] = [],
  personaId: Id = "buy_polly",
) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set.");
    clientWs.close(1011, "Missing OpenAI API Key");
    return;
  }

  let currentDepth = 0;
  let recentConversation: { role: string; text: string }[] = [];
  let routingQueue = Promise.resolve();

  console.log(`Starting mock session for recording ${recordingId} at node ${currentNodeId} (precap: ${includePrecap}, persona: ${personaId}, maxDepth: ${maxDepth}, targetNodeIds: ${targetNodeIds})`);

  if (includePrecap) {
    await handlePrecapPhase(clientWs, recordingId, currentNodeId);
  }

  // This is the LIVE interactive session (precap runs on its own socket). Reset
  // the shared recording's transcript + traversal so it holds exactly this
  // session's turns — the post-call analysis endpoint reads them straight back.
  if (!includePrecap) {
    const rec = getRecording(recordingId);
    if (rec) {
      rec.transcript = [];
      rec.traversal = { initialNodeId: currentNodeId, finalNodeId: currentNodeId, steps: [] };
    }
  }

  const systemPrompt = generateMockPrompt(recordingId, currentNodeId, personaId);

  const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";
  const openaiWs = new WebSocket(url, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "voice": "marin",
    },
  });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime API.");
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              threshold: 0.8,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
            },
            transcription: { model: "whisper-1" },
          },
        },
        instructions: systemPrompt,
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  });

  const runRouter = async (speaker: "seller" | "buyer") => {
    const rec = getRecording(recordingId);
    const tree = rec ? getTree(rec.treeId) : undefined;
    if (!tree) return;

    const current = tree.nodes.find(n => n.id === currentNodeId);
    if (!current) return;

    // Only route if this is the expected responding speaker
    const expectedSpeaker = current.speaker === "buyer" ? "seller" : "buyer";
    if (speaker !== expectedSpeaker) return;

    try {
      const utterance =
        recentConversation
          .filter((m) => m.role === speaker)
          .map((m) => m.text)
          .join(" ") ||
        recentConversation.map((m) => m.text).join(" ");
      // Practice mode is constrained to the authored tree: route to an existing
      // child only, never create a new node.
      const nextNodeId = await chooseExistingChild(tree, currentNodeId, utterance);

      let switchedNode = false;
      if (nextNodeId && nextNodeId !== currentNodeId) {
        console.log(`Routed (${speaker}) to existing node:`, nextNodeId);
        currentNodeId = nextNodeId;
        switchedNode = true;
        clientWs.send(JSON.stringify({ type: "mock_node_matched", nodeId: currentNodeId }));
      } else {
        console.log(`Router stayed at current node (${speaker}):`, currentNodeId);
      }

      if (switchedNode) {
        recentConversation = [];

        // Keep the recording's traversal pointed at where we actually are, so the
        // post-call analysis can derive the outcome from the final node reached.
        if (rec) rec.traversal.finalNodeId = currentNodeId;

        // Update OpenAI system prompt with new node context
        const newSystemPrompt = generateMockPrompt(recordingId, currentNodeId, personaId);
        const sessionUpdate = {
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.8,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 800,
                },
                transcription: { model: "whisper-1" },
              },
            },
            instructions: newSystemPrompt,
          },
        };
        openaiWs.send(JSON.stringify(sessionUpdate));

        currentDepth++;
        let breakpointHit = false;
        let breakpointReason = "";

        if (maxDepth !== undefined && currentDepth >= maxDepth) {
          breakpointHit = true;
          breakpointReason = "depth";
        } else if (targetNodeIds.includes(currentNodeId)) {
          breakpointHit = true;
          breakpointReason = "node";
        }

        if (breakpointHit) {
          console.log(`Breakpoint reached. Reason: ${breakpointReason}`);
          clientWs.send(JSON.stringify({
            type: "mock_breakpoint_reached",
            reason: breakpointReason,
            nodeId: currentNodeId,
            depth: currentDepth,
          }));
          setTimeout(() => openaiWs.close(), 500);
          return;
        }
      }
    } catch (e) {
      console.error("Error branching:", e);
    }
  };

  openaiWs.on("message", async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type !== "response.audio.delta" && event.type !== "response.output_audio.delta") {
        console.log("[OpenAI -> Client]", event.type);
      }

      if (event.type === "response.audio_transcript.done") {
        const transcript = event.transcript;
        if (transcript) {
          routingQueue = routingQueue.then(async () => {
            appendTranscript(recordingId, "buyer", transcript);
            recentConversation.push({ role: "buyer", text: transcript });
            await runRouter("buyer");
          }).catch(console.error);
        }
      } else if (event.type === "response.done") {
        // Fallback: extract transcript from the completed response item
        try {
          const item = event.response.output[0];
          if (item?.content?.[0]?.transcript) {
            const transcript = item.content[0].transcript;
            routingQueue = routingQueue.then(async () => {
              const lastLog = recentConversation[recentConversation.length - 1];
              if (!lastLog || lastLog.text !== transcript) {
                appendTranscript(recordingId, "buyer", transcript);
                recentConversation.push({ role: "buyer", text: transcript });
                await runRouter("buyer");
                clientWs.send(JSON.stringify({ type: "response.audio_transcript.done", transcript }));
              }
            }).catch(console.error);
          }
        } catch (e) {}
      }

      if (event.type === "conversation.item.input_audio_transcription.completed") {
        routingQueue = routingQueue.then(async () => {
          appendTranscript(recordingId, "seller", event.transcript);
          if (event.transcript) {
            recentConversation.push({ role: "seller", text: event.transcript });
            await runRouter("seller");
          }
        }).catch(console.error);
      }

      clientWs.send(data.toString());
    } catch (e) {
      console.error("Error parsing OpenAI message:", e);
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI Realtime connection closed.");
    clientWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WebSocket Error:", err);
  });

  clientWs.on("message", (data) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      try {
        const event = JSON.parse(data.toString());
        if (event.type !== "input_audio_buffer.append") {
          console.log("[Client -> OpenAI]", event.type);
        }
      } catch (e) {
        // binary or unparseable — pass through
      }
      openaiWs.send(data);
    }
  });

  clientWs.on("close", () => {
    console.log("Client connection closed.");
    openaiWs.close();
  });
}

function appendTranscript(recordingId: Id, speaker: "buyer" | "seller", text: string) {
  const rec = getRecording(recordingId);
  if (!rec) return;

  const lastSegment = rec.transcript[rec.transcript.length - 1];
  const tStartMs = lastSegment ? lastSegment.tEndMs : 0;
  const tEndMs = tStartMs + 3000;

  const segment: TranscriptSegment = {
    index: rec.transcript.length,
    speaker,
    text,
    tStartMs,
    tEndMs,
  };

  rec.transcript.push(segment);
  console.log(`[Transcript ${recordingId}] ${speaker}: ${text}`);
}

// ===========================================================================
// "Watch the AI ace this path" — live AI-vs-AI (role=both)
//
// Two OpenAI Realtime sockets (one expert seller, one buyer persona) take turns
// down the tree's optimal branch. We drive each turn explicitly with a per-turn
// directive (no mic, no server VAD), text-bridge each side's words into the
// other for coherence, stream speaker-tagged audio to the client, and emit a
// "why" rationale per move. Deterministic node stepping (we know the path) keeps
// it demo-safe.
// ===========================================================================

const REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";

function generateSellerPrompt(recordingId: Id, currentNodeId: Id): string {
  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;
  const productInfo = rec ? getProductInfo(rec.callId) : getProductInfo("co_slack");

  let pathContext = "No prior context.";
  if (tree && currentNodeId) {
    try {
      const summary = getDecisionSummary(tree, currentNodeId);
      pathContext = summary.path
        .map((n) => `[${n.speaker.toUpperCase()}]: ${n.description}`)
        .join("\n");
    } catch {
      // fall through with default
    }
  }

  return `
You are an elite B2B sales representative on a live call, demonstrating a textbook-perfect handling of this deal.

PRODUCT CONTEXT:
${productInfo}

CONVERSATION SO FAR:
${pathContext}

INSTRUCTIONS:
1. Stay strictly in character as the seller (the rep). Never break character.
2. Be confident, warm, and concise — 1-2 sentences per turn, like a top closer.
3. Respond directly to what the buyer just said.
4. Follow the per-turn director guidance exactly to hit the intended move.
`;
}

/** The per-turn instruction steering a side to voice a specific node's move. */
function directiveForNode(node: TreeNode): string {
  const who = node.speaker === "seller" ? "the seller (rep)" : "the buyer";
  return `As ${who}, say one natural, concise line (1-2 sentences) that accomplishes this beat: "${node.title}" — ${node.description}. Do not narrate or add stage directions; just speak the line.`;
}

/** Templated "why this move works" — deterministic, instant, demo-safe. */
function buildRationale(tree: Tree, node: TreeNode, prevSuccess: number | null): string {
  if (node.speaker === "buyer") {
    return `The buyer responds: "${node.description}".`;
  }
  const alts = getDecisionAlternatives(tree, node.id, new Set());
  const weaker = alts
    .filter((a) => a.successProbability < node.successProbability)
    .sort((a, b) => a.successProbability - b.successProbability)[0];
  if (weaker) {
    return `Lead with "${node.title}" (${node.description}) instead of "${weaker.title}" — the stronger play here.`;
  }
  if (prevSuccess !== null && node.successProbability > prevSuccess) {
    return `"${node.title}" — ${node.description}. This keeps the deal moving.`;
  }
  return `"${node.title}" — ${node.description}.`;
}

interface AiSide {
  ws: WebSocket;
  speaker: "seller" | "buyer";
  ready: Promise<void>;
  pending: { resolve: (t: string) => void; transcript: string } | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

function createRealtimeSide(
  clientWs: WebSocket,
  apiKey: string,
  speaker: "seller" | "buyer",
  voice: string,
  instructions: string,
  isClosed: () => boolean,
): AiSide {
  const ws = new WebSocket(REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, voice },
  });

  const side: AiSide = { ws, speaker, ready: Promise.resolve(), pending: null, timeout: null };
  let markReady: () => void = () => {};
  side.ready = new Promise<void>((res) => (markReady = res));
  let readyFired = false;

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions,
          // No mic on either side — disable VAD so the AI never auto-responds;
          // turns are driven explicitly via response.create.
          audio: { input: { turn_detection: null } },
        },
      }),
    );
  });

  ws.on("message", (data) => {
    let ev: any;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (ev.type) {
      case "session.updated":
        if (!readyFired) {
          readyFired = true;
          markReady();
        }
        break;
      case "response.audio.delta":
      case "response.output_audio.delta":
        if (!isClosed()) {
          clientWs.send(
            JSON.stringify({ type: "both_audio", speaker, delta: ev.delta }),
          );
        }
        break;
      case "response.audio_transcript.done":
        if (side.pending && ev.transcript) side.pending.transcript = ev.transcript;
        break;
      case "response.done": {
        if (side.pending) {
          if (side.timeout) clearTimeout(side.timeout);
          let t = side.pending.transcript;
          if (!t) {
            try {
              t = ev.response.output[0].content[0].transcript;
            } catch {
              t = "";
            }
          }
          const resolve = side.pending.resolve;
          side.pending = null;
          resolve(t || "");
        }
        break;
      }
      case "error":
        console.error(`[both:${speaker}] realtime error`, ev.error ?? ev);
        break;
      default:
        break;
    }
  });

  ws.on("error", (err) => console.error(`[both:${speaker}] ws error`, err));
  return side;
}

/** Trigger one spoken turn on a side and resolve with its transcript. */
function runTurn(side: AiSide, directive: string): Promise<string> {
  return new Promise<string>((resolve) => {
    side.pending = { resolve, transcript: "" };
    side.ws.send(
      JSON.stringify({ type: "response.create", response: { instructions: directive } }),
    );
    // Safety net so a dropped response.done can't stall the whole demo.
    side.timeout = setTimeout(() => {
      if (side.pending) {
        const t = side.pending.transcript;
        side.pending = null;
        resolve(t);
      }
    }, 20000);
  });
}

/** Inject the other party's line so this side stays conversationally coherent. */
function feedContext(side: AiSide, fromSpeaker: "seller" | "buyer", text: string) {
  if (!text) return;
  side.ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[${fromSpeaker.toUpperCase()}]: ${text}` }],
      },
    }),
  );
}

/** Highest-success child of a node — the move we steer the AI toward each turn. */
function optimalChildOf(tree: Tree, nodeId: Id): TreeNode | null {
  const children = getNodeChildren(tree, nodeId);
  if (children.length === 0) return null;
  return children.reduce((best, c) =>
    c.successProbability > best.successProbability ? c : best,
  );
}

/**
 * Decide which node the AI's utterance actually lands on — the same idea as the
 * live flow routing the human's reply, but among the current node's existing
 * children and biased to the steered optimal child: only diverge when the
 * utterance clearly matches a different child, so the "ace it" demo stays clean
 * (no stray 0.5-probability nodes).
 */
function chooseNextNode(tree: Tree, currentNodeId: Id, utterance: string, optimalId: Id): Id {
  const children = getNodeChildren(tree, currentNodeId);
  if (children.length === 0) return currentNodeId;
  if (children.length === 1) return children[0].id;
  const match = bestMatch(tree, currentNodeId, utterance);
  if (match && match.nodeId !== optimalId && match.score >= 0.3) return match.nodeId;
  return optimalId;
}

export async function handleBothSession(
  clientWs: WebSocket,
  recordingId: Id,
  currentNodeId: Id,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    clientWs.close(1011, "Missing OpenAI API Key");
    return;
  }

  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;
  if (!tree) {
    clientWs.send(JSON.stringify({ type: "error", error: "Tree not found." }));
    clientWs.close();
    return;
  }

  const startNode = getNodeById(tree, currentNodeId);
  if (!startNode) {
    clientWs.send(JSON.stringify({ type: "mock_complete", nodeId: currentNodeId }));
    clientWs.close();
    return;
  }
  console.log(`[both] watch from ${currentNodeId} (${startNode.title})`);

  let closed = false;
  const isClosed = () => closed;

  const sellerSide = createRealtimeSide(
    clientWs,
    apiKey,
    "seller",
    "cedar",
    generateSellerPrompt(recordingId, currentNodeId),
    isClosed,
  );
  const buyerSide = createRealtimeSide(
    clientWs,
    apiKey,
    "buyer",
    "marin",
    generateMockPrompt(recordingId, currentNodeId),
    isClosed,
  );

  const teardown = () => {
    closed = true;
    if (sellerSide.timeout) clearTimeout(sellerSide.timeout);
    if (buyerSide.timeout) clearTimeout(buyerSide.timeout);
    try { sellerSide.ws.close(); } catch {}
    try { buyerSide.ws.close(); } catch {}
  };

  clientWs.on("close", teardown);

  const sideFor = (speaker: "seller" | "buyer") => (speaker === "seller" ? sellerSide : buyerSide);
  const otherFor = (speaker: "seller" | "buyer") => (speaker === "seller" ? buyerSide : sellerSide);

  // Send a node's tree-focus + rationale cues for a just-spoken turn.
  const emitNode = (node: TreeNode, prevSuccess: number | null) => {
    clientWs.send(JSON.stringify({ type: "mock_node_matched", nodeId: node.id }));
    clientWs.send(
      JSON.stringify({
        type: "both_rationale",
        nodeId: node.id,
        text: buildRationale(tree, node, prevSuccess),
        successProbability: node.successProbability,
        expectedValue: node.expectedValue,
        prevSuccess,
        deltaWinRate: prevSuccess === null ? 0 : Math.round((node.successProbability - prevSuccess) * 100),
      }),
    );
  };

  try {
    // Wait for both realtime sessions to be configured (with a hard timeout).
    await Promise.race([
      Promise.all([sellerSide.ready, buyerSide.ready]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Realtime connect timeout")), 15000)),
    ]);

    let nodeId = currentNodeId;
    let prevSuccess: number | null = null;

    // 1) Voice the starting node for context — we're already on it, just narrate.
    {
      const node = startNode;
      const side = sideFor(node.speaker);
      const other = otherFor(node.speaker);
      clientWs.send(JSON.stringify({ type: "both_speaker", speaker: node.speaker }));
      emitNode(node, null);
      const transcript = await runTurn(side, directiveForNode(node));
      if (!closed && transcript) {
        clientWs.send(JSON.stringify({ type: "both_transcript", speaker: node.speaker, text: transcript, nodeId: node.id }));
        feedContext(other, node.speaker, transcript);
      }
      prevSuccess = node.successProbability;
    }

    // 2) Walk forward, deriving each step from what the AI actually says.
    const MAX_TURNS = 12;
    let turns = 0;
    while (!closed && turns < MAX_TURNS) {
      const optimal = optimalChildOf(tree, nodeId);
      if (!optimal) break; // reached a leaf

      const speaker = optimal.speaker;
      const side = sideFor(speaker);
      const other = otherFor(speaker);

      // who's talking now (captured before the audio so the FE can sync the turn)
      clientWs.send(JSON.stringify({ type: "both_speaker", speaker }));
      const transcript = await runTurn(side, directiveForNode(optimal));
      if (closed) break;

      // route: which node did the utterance actually land on?
      nodeId = chooseNextNode(tree, nodeId, transcript, optimal.id);
      const chosen = getNodeById(tree, nodeId);
      if (!chosen) break;

      emitNode(chosen, prevSuccess);
      if (transcript) {
        clientWs.send(JSON.stringify({ type: "both_transcript", speaker, text: transcript, nodeId: chosen.id }));
        feedContext(other, speaker, transcript);
      }
      prevSuccess = chosen.successProbability;
      turns++;
    }

    if (!closed) {
      clientWs.send(JSON.stringify({ type: "mock_complete", nodeId }));
    }
  } catch (e) {
    console.error("[both] session error", e);
    if (!closed) clientWs.send(JSON.stringify({ type: "error", error: e instanceof Error ? e.message : "Both-session failed." }));
  } finally {
    teardown();
    // Let the last audio chunk flush to the client before closing.
    setTimeout(() => { try { clientWs.close(); } catch {} }, 1500);
  }
}
