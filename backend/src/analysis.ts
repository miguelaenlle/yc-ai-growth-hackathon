// analysis.ts — post-mock-call review generator.
//
// generateMockAnalysis() runs once, after a HUMAN practice mock call ends. It
// reads the call transcript plus a short summary of the rep's historical stats
// and asks gpt-4o-mini to grade the call against a fixed skill taxonomy.
//
// Follows the fetch + json_object pattern in assist.ts / mock.ts precap, and is
// robust: a missing OPENAI_API_KEY or a failed call yields a graceful fallback
// rather than throwing, so the post-call popup always renders.

import { SKILL_TAXONOMY, type SkillTag } from "./salesperson-stats.js";
import type { TranscriptSegment } from "./types.js";

import dotenv from "dotenv";
dotenv.config();

/** Raw shape returned by the analysis LLM (before code-side validation). */
export interface MockAnalysisLLM {
  summary: string;
  topStrength: string;
  topWeakness: string;
  skillTags: SkillTag[];
  nodeFails: string[];
}

export interface MockAnalysisParams {
  transcript: TranscriptSegment[];
  productInfo: string;
  personaName: string;
  personaDescription: string;
  statsSummary: string;
  /** Valid seed node ids the model may cite in nodeFails (grounds the output). */
  nodeIds: string[];
}

const VALID_SKILLS = new Set<string>(SKILL_TAXONOMY);

/** Keep only taxonomy skills, dedup by category, coerce passed to boolean. */
function sanitizeSkillTags(raw: unknown): SkillTag[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SkillTag[] = [];
  for (const item of raw) {
    const category = typeof item?.category === "string" ? item.category : "";
    if (!VALID_SKILLS.has(category) || seen.has(category)) continue;
    seen.add(category);
    out.push({ category, passed: Boolean(item.passed) });
  }
  return out;
}

/** Keep only ids that exist in the tree. */
function sanitizeNodeFails(raw: unknown, validIds: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(validIds);
  return [...new Set(raw.filter((id) => typeof id === "string" && valid.has(id)))];
}

export async function generateMockAnalysis(
  params: MockAnalysisParams,
): Promise<MockAnalysisLLM> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return fallback(params.transcript);

  const transcriptText =
    params.transcript.length > 0
      ? params.transcript
          .map((s) => `[${s.speaker.toUpperCase()}]: ${s.text}`)
          .join("\n")
      : "(no transcript captured)";

  const systemPrompt =
    "You are a sales coach reviewing a single practice mock call between a seller " +
    "(the rep being coached) and an AI buyer playing a persona. Be specific, concrete, " +
    "and grounded in what was actually said. Do not invent metrics. Respond ONLY with JSON.";

  const userPrompt =
    `PRODUCT BEING SOLD:\n${params.productInfo}\n\n` +
    `BUYER PERSONA — ${params.personaName}:\n${params.personaDescription}\n\n` +
    `THE REP'S HISTORICAL STATS:\n${params.statsSummary}\n\n` +
    `FULL CALL TRANSCRIPT:\n${transcriptText}\n\n` +
    `SKILL TAXONOMY (tag ONLY the skills that actually came up in this call):\n` +
    `${SKILL_TAXONOMY.join(", ")}\n\n` +
    `SEED NODE IDS the rep may have mishandled (cite only ids from this list, or omit):\n` +
    `${params.nodeIds.join(", ") || "(none)"}\n\n` +
    `Return a JSON object with exactly these keys:\n` +
    `{\n` +
    `  "summary": string (2-3 sentences on how the call went),\n` +
    `  "topStrength": string (one concrete thing the rep did well),\n` +
    `  "topWeakness": string (one concrete thing to improve),\n` +
    `  "skillTags": [{ "category": <one of the taxonomy>, "passed": boolean }] (only skills that came up),\n` +
    `  "nodeFails": string[] (seed node ids mishandled; [] if none)\n` +
    `}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      console.error("[analysis] OpenAI failed:", await res.text());
      return fallback(params.transcript);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    const parsed = JSON.parse(data.choices[0].message.content) as Record<
      string,
      unknown
    >;

    return {
      summary:
        typeof parsed.summary === "string"
          ? parsed.summary
          : "Call reviewed.",
      topStrength:
        typeof parsed.topStrength === "string"
          ? parsed.topStrength
          : "Kept the conversation moving.",
      topWeakness:
        typeof parsed.topWeakness === "string"
          ? parsed.topWeakness
          : "Room to tighten the close.",
      skillTags: sanitizeSkillTags(parsed.skillTags),
      nodeFails: sanitizeNodeFails(parsed.nodeFails, params.nodeIds),
    };
  } catch (e) {
    console.error("[analysis] generateMockAnalysis error:", e);
    return fallback(params.transcript);
  }
}

/** Deterministic fallback when the model is unavailable — keeps the popup alive. */
function fallback(transcript: TranscriptSegment[]): MockAnalysisLLM {
  const hadConversation = transcript.length > 0;
  return {
    summary: hadConversation
      ? "You ran the practice call to the end. We couldn't reach the analysis model, so this is a basic recap rather than a detailed breakdown."
      : "The call ended before there was enough conversation to analyze.",
    topStrength: "Engaged the buyer and worked the conversation.",
    topWeakness: "Detailed analysis unavailable — the coaching model couldn't be reached.",
    skillTags: [],
    nodeFails: [],
  };
}
