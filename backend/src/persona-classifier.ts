// persona-classifier.ts — Classify an uploaded call's buyer into one of the
// fixed buyer personas, plus a job title, from the buyer name + transcript.
//
// Seeded buyers carry a `personaId` (which archetype the AI plays in practice)
// and a real `title`. The upload pipeline creates buyers without either, so this
// runs a single GPT pass to fill them in — grounded against the real persona list
// (the same one GET /personas serves) with a safe fallback.

import { listPersonas } from "./personas.js";
import type { TranscriptSegment } from "./types.js";

const FALLBACK_PERSONA = "buy_steve";

export interface BuyerClassification {
  personaId: string;
  title: string;
}

/**
 * Pick the best-fit persona id + a buyer job title for an uploaded call. Returns
 * a safe fallback (Skeptical Steve, blank title) if the LLM is unavailable or the
 * response is unusable — never throws.
 */
export async function classifyBuyer(
  buyerName: string,
  transcript: TranscriptSegment[],
): Promise<BuyerClassification> {
  const personas = listPersonas();
  const validIds = new Set(personas.map((p) => p.id));
  const fallback: BuyerClassification = { personaId: FALLBACK_PERSONA, title: "" };

  const key = process.env["OPENAI_API_KEY"];
  if (!key) return fallback;

  // Buyer turns carry the signal; cap length to keep the prompt small.
  const buyerLines = transcript
    .filter((s) => s.speaker === "buyer")
    .map((s) => s.text)
    .join(" ")
    .slice(0, 3000);
  const dialogue = transcript
    .map((s) => `${s.speaker.toUpperCase()}: ${s.text}`)
    .join("\n")
    .slice(0, 6000);

  const personaList = personas.map((p) => `- ${p.id} (${p.name}): ${p.description}`).join("\n");

  const system =
    "You classify the BUYER on a B2B sales call into exactly one persona archetype, " +
    "and infer their likely job title. Base it ONLY on how the buyer behaves in the transcript. " +
    "Respond ONLY with JSON.";
  const user =
    `BUYER NAME: ${buyerName}\n\n` +
    `PERSONAS (choose exactly one id):\n${personaList}\n\n` +
    `BUYER'S LINES:\n${buyerLines || "(buyer said little)"}\n\n` +
    `FULL TRANSCRIPT:\n${dialogue}\n\n` +
    `Return JSON: { "personaId": "<one id from the list above>", "title": "<short job title, e.g. 'VP of Engineering'>" }`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      console.error("[persona-classifier] OpenAI failed:", await res.text().catch(() => "(no body)"));
      return fallback;
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0].message.content) as { personaId?: string; title?: string };
    const personaId = parsed.personaId && validIds.has(parsed.personaId) ? parsed.personaId : FALLBACK_PERSONA;
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 60) : "";
    return { personaId, title };
  } catch (e) {
    console.error("[persona-classifier] error:", e);
    return fallback;
  }
}
