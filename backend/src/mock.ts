import WebSocket from "ws";
import { getDecisionSummary, matchOrCreateBranch } from "./tree-ops.js";
import { getRecording, getTree, store } from "./store.js";
import type { Id, Recording, Tree, TranscriptSegment } from "./types.js";

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "data", "cache");

import { getPersonaInfo } from "./personas.js";

function getProductInfo(companyId: Id): string {
  if (companyId === "co_convex") {
    return "Convex is a high-performance backend-as-a-service. It syncs state in real-time, guarantees transactional consistency, and is a $48k ACV deal.";
  }
  return "Unknown product.";
}

function generateMockPrompt(recordingId: Id, currentNodeId: Id): string {
  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;

  const productInfo = rec ? getProductInfo(rec.callId) : getProductInfo("co_convex");
  const personaInfo = getPersonaInfo("buy_polly");

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

    const llmData = await llmRes.json();
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

export async function handleMockSession(
  clientWs: WebSocket,
  recordingId: Id,
  currentNodeId: Id,
  includePrecap: boolean,
  maxDepth?: number,
  targetNodeIds: string[] = [],
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

  console.log(`Starting mock session for recording ${recordingId} at node ${currentNodeId} (precap: ${includePrecap}, maxDepth: ${maxDepth}, targetNodeIds: ${targetNodeIds})`);

  if (includePrecap) {
    await handlePrecapPhase(clientWs, recordingId, currentNodeId);
  }

  const systemPrompt = generateMockPrompt(recordingId, currentNodeId);

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
      const result = await matchOrCreateBranch(tree, currentNodeId, recentConversation, speaker);

      let switchedNode = false;
      if (result.created) {
        console.log(`New node created from ${speaker} input:`, result.node.id);
        currentNodeId = result.node.id;
        switchedNode = true;
        clientWs.send(JSON.stringify({ type: "mock_node_created", nodeId: currentNodeId, title: result.node.title, parentId: current.id }));
      } else if (result.matchedNodeId !== currentNodeId) {
        console.log(`Matched existing node (${speaker}):`, result.matchedNodeId);
        currentNodeId = result.matchedNodeId;
        switchedNode = true;
        clientWs.send(JSON.stringify({ type: "mock_node_matched", nodeId: currentNodeId }));
      } else {
        console.log(`Router stayed at current node (${speaker}):`, currentNodeId);
      }

      if (switchedNode) {
        recentConversation = [];

        // Update OpenAI system prompt with new node context
        const newSystemPrompt = generateMockPrompt(recordingId, currentNodeId);
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
