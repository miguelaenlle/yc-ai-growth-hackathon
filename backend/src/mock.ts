import WebSocket from "ws";
import { getDecisionSummary, matchOrCreateBranch } from "./tree-ops.js";
import { getRecording, getTree, store } from "./store.js";
import type { Id, Recording, Tree, TranscriptSegment } from "./types.js";

// Ensure the API key is loaded
import dotenv from "dotenv";
dotenv.config();

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
 * Stubbed persona info
 */
function getPersonaInfo(buyerId: Id): string {
  if (buyerId === "buy_john") {
    return "John is a VP of Operations. His team is drowning in support tickets. His analytics team lives in Tableau, which is a hard requirement for him.";
  }
  return "Unknown persona.";
}

/**
 * Generates the system instructions for the OpenAI Realtime API.
 */
function generateMockPrompt(recordingId: Id, currentNodeId: Id): string {
  const rec = getRecording(recordingId);
  const tree = rec ? getTree(rec.treeId) : undefined;

  const productInfo = rec ? getProductInfo(rec.callId) : getProductInfo("co_convex"); // simplification
  const personaInfo = rec ? getPersonaInfo("buy_john") : getPersonaInfo("buy_john"); // simplification

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
 * Handles the WebSocket session connecting the frontend to OpenAI.
 */
export function handleMockSession(clientWs: WebSocket, recordingId: Id, currentNodeId: Id) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set.");
    clientWs.close(1011, "Missing OpenAI API Key");
    return;
  }

  console.log(`Starting mock session for recording ${recordingId} at node ${currentNodeId}`);

  const systemPrompt = generateMockPrompt(recordingId, currentNodeId);

  // Connect to OpenAI Realtime API
  const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";
  const openaiWs = new WebSocket(url, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
  });

  // When OpenAI connection opens, initialize the session
  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime API.");

    // Send session update with instructions
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: systemPrompt,
        turn_detection: {
          type: "server_vad",
        },
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  });

  // Route messages from OpenAI -> Client
  openaiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());

      // Keep track of transcript when available
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        appendTranscript(recordingId, "seller", event.transcript);

        // Try to branch the tree based on the seller's input
        const rec = getRecording(recordingId);
        const tree = rec ? getTree(rec.treeId) : undefined;
        if (tree && event.transcript) {
          try {
            const result = matchOrCreateBranch(tree, currentNodeId, event.transcript);
            if (result.created) {
              console.log("New node created from seller input:", result.node.id);
              currentNodeId = result.node.id;
            } else {
              console.log("Matched existing node:", result.matchedNodeId);
              currentNodeId = result.matchedNodeId;
            }
          } catch (e) {
            console.error("Error branching:", e);
          }
        }
      } else if (event.type === "response.audio_transcript.done") {
        appendTranscript(recordingId, "buyer", event.transcript);
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
