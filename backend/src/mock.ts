import WebSocket from "ws";
import { getDecisionSummary, matchOrCreateBranch } from "./tree-ops.js";
import { getRecording, getTree, store } from "./store.js";
import type { Id, Recording, Tree, TranscriptSegment } from "./types.js";

// Ensure the API key is loaded
import dotenv from "dotenv";
dotenv.config();

import { getPersonaInfo } from "./personas.js";

/**
 * Stubbed product info
 */
function getProductInfo(companyId: Id): string {
  if (companyId === "co_convex") {
    return "Convex is a high-performance backend-as-a-service. It syncs state in real-time, guarantees transactional consistency, and is a $48k ACV deal.";
  }
  return "Unknown product.";
}

/**
 * Generates the system instructions for the OpenAI Realtime API.
 */
function generateMockPrompt(recordingId: Id, currentNodeId: Id): string {
  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;

  const productInfo = rec ? getProductInfo(rec.callId) : getProductInfo("co_convex"); // simplification
  const personaInfo = getPersonaInfo("skeptical_steve");

  let pathContext = "No prior context.";
  if (tree && currentNodeId) {
    try {
      const summary = getDecisionSummary(tree, currentNodeId);
      pathContext = summary.path.map(n => `[${n.speaker.toUpperCase()}]: ${n.description}`).join("\n");
    } catch (e) {
      console.warn("Could not get decision summary, using fallback");
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

INSTRUCTIONS:
1. Stay strictly in character as the buyer. 
2. Keep your responses conversational, concise, and realistic. 
3. Do not break character or acknowledge that you are an AI.
4. Respond directly to the user's audio input.
`;
}

/**
 * Handles the precap phase by generating TTS for the path up to the current node.
 */
async function handlePrecapPhase(clientWs: WebSocket, recordingId: Id, currentNodeId: Id) {
  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;
  if (!tree || !currentNodeId) {
    clientWs.send(JSON.stringify({ type: "precap_complete" }));
    return;
  }

  try {
    const summary = getDecisionSummary(tree, currentNodeId);
    
    // Request script from LLM
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
        response_format: { type: "json_object" }
      })
    });

    if (!llmRes.ok) {
      console.error("LLM Precap failed:", await llmRes.text());
      clientWs.send(JSON.stringify({ type: "precap_complete" }));
      return;
    }

    const llmData = await llmRes.json();
    const parsed = JSON.parse(llmData.choices[0].message.content);
    const script = parsed.script || [];

    for (const chunk of script) {
      // Send the node sync event
      clientWs.send(JSON.stringify({ type: "precap_node", nodeId: chunk.nodeId }));

      // We simulate TTS by fetching from OpenAI TTS API
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
        })
      });

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const b64_data = Buffer.from(arrayBuffer).toString('base64');
        clientWs.send(JSON.stringify({ type: "precap_audio", b64_data }));
      } else {
        console.error("TTS failed:", await response.text());
      }
    }
  } catch (e) {
    console.error("Error during precap:", e);
  }

  // Signal the frontend that precap is complete
  clientWs.send(JSON.stringify({ type: "precap_complete" }));
}

/**
 * Handles the WebSocket session connecting the frontend to OpenAI.
 */
export async function handleMockSession(
  clientWs: WebSocket, 
  recordingId: Id, 
  currentNodeId: Id, 
  includePrecap: boolean,
  maxDepth?: number,
  targetNodeIds: string[] = []
) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set.");
    clientWs.close(1011, "Missing OpenAI API Key");
    return;
  }

  let currentDepth = 0;
  let recentConversation: { role: string; text: string }[] = [];

  console.log(`Starting mock session for recording ${recordingId} at node ${currentNodeId} (precap: ${includePrecap}, maxDepth: ${maxDepth}, targetNodeIds: ${targetNodeIds})`);

  if (includePrecap) {
    await handlePrecapPhase(clientWs, recordingId, currentNodeId);
  }

  const systemPrompt = generateMockPrompt(recordingId, currentNodeId);

  // Connect to OpenAI Realtime API
  const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";
  const openaiWs = new WebSocket(url, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "voice": "marin",
    },
  });

  // When OpenAI connection opens, initialize the session
  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime API.");

    // Send session update with instructions
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        turn_detection: {
          type: "server_vad",
          threshold: 0.8,
          prefix_padding_ms: 300,
          silence_duration_ms: 800
        },
        instructions: systemPrompt
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  });

  // Route messages from OpenAI -> Client
  openaiWs.on("message", async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type !== "response.audio.delta" && event.type !== "response.output_audio.delta") {
         console.log("[OpenAI -> Client]", event.type);
      }

      if (event.type === "response.audio_transcript.done") {
        appendTranscript(recordingId, "buyer", event.transcript);
        if (event.transcript) {
          recentConversation.push({ role: "buyer", text: event.transcript });
        }
      }

      // Keep track of transcript when available
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        appendTranscript(recordingId, "seller", event.transcript);
        if (event.transcript) {
          recentConversation.push({ role: "seller", text: event.transcript });
        }

        // Try to branch the tree based on the seller's input
        const rec = getRecording(recordingId);
        const tree = rec ? getTree(rec.treeId) : undefined;
        if (tree && event.transcript) {
          try {
            const result = await matchOrCreateBranch(tree, currentNodeId, recentConversation);
            
            let switchedNode = false;
            if (result.created) {
              console.log("New node created from seller input:", result.node.id);
              currentNodeId = result.node.id;
              switchedNode = true;
              clientWs.send(JSON.stringify({ type: "mock_node_created", nodeId: currentNodeId, title: result.node.title }));
            } else if (result.matchedNodeId !== currentNodeId) {
              console.log("Matched existing node:", result.matchedNodeId);
              currentNodeId = result.matchedNodeId;
              switchedNode = true;
              clientWs.send(JSON.stringify({ type: "mock_node_matched", nodeId: currentNodeId }));
            } else {
              console.log("LLM router elected to stay at current node:", currentNodeId);
            }

            if (switchedNode) {
              recentConversation = []; // Reset context since we moved

              // Depth Tracking
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
                  depth: currentDepth
                }));
                
                // End the session to stop OpenAI from talking
                openaiWs.close();
                return;
              }
            }
          } catch (e) {
            console.error("Error branching:", e);
          }
        }
      }

      // Forward event to the frontend
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

  // Route messages from Client -> OpenAI
  clientWs.on("message", (data) => {
    // If the client sends raw binary or JSON, just pass it to OpenAI.
    // We expect the frontend to send standard OpenAI JSON events (e.g. input_audio_buffer.append)
    if (openaiWs.readyState === WebSocket.OPEN) {
      try {
        const event = JSON.parse(data.toString());
        if (event.type !== "input_audio_buffer.append") {
          console.log("[Client -> OpenAI]", event.type);
        }
      } catch (e) {
        // likely binary or unparseable, ignore
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

  // Dummy timestamp logic for now
  const lastSegment = rec.transcript[rec.transcript.length - 1];
  const tStartMs = lastSegment ? lastSegment.tEndMs : 0;
  const tEndMs = tStartMs + 3000; // arbitrary 3s duration

  const segment: TranscriptSegment = {
    index: rec.transcript.length,
    speaker,
    text,
    tStartMs,
    tEndMs
  };

  rec.transcript.push(segment);
  console.log(`[Transcript ${recordingId}] ${speaker}: ${text}`);
}
