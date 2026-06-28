// assist.ts — Real-time seller assist card generator.
//
// generateAssistCard() fires after each buyer utterance during a live call.
// It calls gpt-4o with the web_search_preview tool so GPT can look up current
// facts (pricing, dates, competitor info) when needed.
//
// The result is an AssistCard shown in the seller's coaching overlay.

import type { AssistCard, TranscriptSegment } from "./types.js";

import dotenv from "dotenv";
dotenv.config();

const ASSIST_WINDOW = 6; // number of recent segments to include as context

// Minimum word count before we bother calling the API.
// Skips filler turns like "yes", "mm-hmm", "right", "okay" — saves a GPT call each time.
const MIN_WORDS_FOR_ASSIST = 6;

// Keywords that indicate the buyer is asking for specific external facts.
// When present we enable web_search_preview; otherwise we skip it to avoid the per-search charge.
const WEB_SEARCH_TRIGGERS = [
  "price", "pricing", "cost", "competitor", "alternative",
  "integration", "roadmap", "timeline", "case study", "reference",
  "compared", "versus", "vs", "how does", "what is", "which",
];

function needsWebSearch(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  return WEB_SEARCH_TRIGGERS.some((kw) => lower.includes(kw));
}

/**
 * Generate a real-time seller assist card for a buyer utterance.
 *
 * @param buyerUtterance  - The raw text of what the buyer just said.
 * @param productContext  - Plain-English product description (from product.ts).
 * @param recentSegments  - Rolling transcript window (most recent last).
 * @returns               An AssistCard ready to emit as a LiveEvent, or null if the
 *                        utterance is too short to warrant an API call.
 */
export async function generateAssistCard(
  buyerUtterance: string,
  productContext: string,
  recentSegments: TranscriptSegment[],
): Promise<AssistCard | null> {
  // Skip filler/short turns — not worth a GPT call
  const wordCount = buyerUtterance.trim().split(/\s+/).length;
  if (wordCount < MIN_WORDS_FOR_ASSIST) {
    console.log(`[assist] Skipping short utterance (${wordCount} words): "${buyerUtterance}"`);
    return null;
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return {
      triggerText: buyerUtterance,
      response: "Assist unavailable — OPENAI_API_KEY not set.",
      searchedWeb: false,
    };
  }

  const window = recentSegments.slice(-ASSIST_WINDOW);
  const conversationCtx = window
    .map((s) => `[${s.speaker.toUpperCase()}]: ${s.text}`)
    .join("\n");

  const systemPrompt =
    "You are a real-time assistant helping a salesperson respond during a live sales call. " +
    "Be concise, accurate, and direct. Keep responses to 2–4 sentences. No filler phrases.";

  const userPrompt =
    `The seller is pitching: ${productContext}\n\n` +
    `RECENT CONVERSATION:\n${conversationCtx}\n\n` +
    `THE BUYER JUST SAID: "${buyerUtterance}"\n\n` +
    `Give the seller a concise, accurate response they can use right now.`;

  // Only enable web search when the buyer's question looks factual/external.
  // This avoids the per-search charge on every conversational turn.
  const useWebSearch = needsWebSearch(buyerUtterance);
  const tools = useWebSearch ? [{ type: "web_search_preview" }] : [];

  try {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini", // cheaper than gpt-4o; sufficient for concise coaching responses
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (tools.length > 0) body.tools = tools;

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[assist] OpenAI /responses failed:", errText);
      return fallback(buyerUtterance);
    }

    const data = await res.json() as {
      output: { type: string; content?: { type: string; text?: string }[] }[];
    };

    const searchedWeb = data.output.some((item) => item.type === "web_search_call");

    const textItem = data.output.find((item) => item.type === "message");
    const response =
      textItem?.content?.find((c) => c.type === "output_text")?.text?.trim() ??
      "No response generated.";

    return { triggerText: buyerUtterance, response, searchedWeb };
  } catch (e) {
    console.error("[assist] generateAssistCard error:", e);
    return fallback(buyerUtterance);
  }
}

function fallback(buyerUtterance: string): AssistCard {
  return {
    triggerText: buyerUtterance,
    response: "Could not generate assist card — please respond based on your knowledge.",
    searchedWeb: false,
  };
}
