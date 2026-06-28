// voice-selector.ts — ElevenLabs voice assignment for buyers.
//
// At server startup, any buyer without a voiceId gets one assigned by GPT-4o-mini:
//   buyer name + title + persona description → best matching ElevenLabs voice_id
//
// Two cache files under data/cache/:
//   elevenlabs-voices.json  — premade American English voices from ElevenLabs API
//   buyer-voices.json       — not used (voiceId lives on the Buyer record in seed.json)

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { store, persist } from "./store.js";
import { getPersonaInfo } from "./personas.js";

import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "data", "cache");
const VOICES_CACHE_PATH = join(CACHE_DIR, "elevenlabs-voices.json");
const NARRATOR_CACHE_PATH = join(CACHE_DIR, "narrator-voice.json");

/** In-memory narrator voice — set by ensureNarratorVoice() at startup. */
let narratorVoiceId: string | null = null;

/** Subset of the ElevenLabs voice object we care about. */
export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  description: string | null;
  labels: Record<string, string>;
  preview_url: string | null;
}

/** Fallback voice (Rachel — reliable ElevenLabs premade, American English female). */
export const FALLBACK_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

// ---------------------------------------------------------------------------
// Voice cache
// ---------------------------------------------------------------------------

/** Fetch premade American English voices from ElevenLabs /v2/voices and write to disk. */
async function fetchAndCacheVoices(): Promise<ElevenLabsVoice[]> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const res = await fetch(
    "https://api.elevenlabs.io/v2/voices?category=premade&search=american&page_size=100",
    { headers: { "xi-api-key": apiKey } },
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs voices fetch failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { voices: ElevenLabsVoice[] };
  const voices = data.voices ?? [];

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(VOICES_CACHE_PATH, JSON.stringify(voices, null, 2));
  console.log(`[voice-selector] Cached ${voices.length} ElevenLabs premade American voices`);
  return voices;
}

/** Load voice cache from disk, fetching fresh from ElevenLabs if missing. */
async function loadVoiceCache(): Promise<ElevenLabsVoice[]> {
  try {
    const raw = await fs.readFile(VOICES_CACHE_PATH, "utf-8");
    const voices = JSON.parse(raw) as ElevenLabsVoice[];
    console.log(`[voice-selector] Loaded ${voices.length} voices from cache`);
    return voices;
  } catch {
    return fetchAndCacheVoices();
  }
}

// ---------------------------------------------------------------------------
// GPT-based voice selection
// ---------------------------------------------------------------------------

/** Resolve GPT output to a voice — by voice_id first, then by name if GPT returned the label. */
function resolveVoiceChoice(raw: string, voices: ElevenLabsVoice[]): ElevenLabsVoice | undefined {
  const trimmed = raw.trim();
  const byId = voices.find((v) => v.voice_id === trimmed);
  if (byId) return byId;

  const lower = trimmed.toLowerCase();
  return voices.find(
    (v) =>
      v.name.toLowerCase() === lower ||
      v.name.toLowerCase().startsWith(lower) ||
      lower.startsWith(v.name.toLowerCase()),
  );
}

/** Ask GPT-4o-mini to pick the best voice_id for a buyer from the available list. */
async function selectVoiceWithGpt(
  buyerName: string,
  buyerTitle: string,
  personaDescription: string,
  voices: ElevenLabsVoice[],
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const voiceSummary = voices.map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    labels: v.labels,
    description: v.description ?? "",
  }));

  const exampleId = voices[0]?.voice_id ?? "hpp4J3VqNfWAUOO0d1Us";

  const prompt = `You are selecting the best ElevenLabs text-to-speech voice for an AI buyer persona in a sales training simulation.

BUYER:
Name: ${buyerName}
Title: ${buyerTitle}
Persona behavior: ${personaDescription}

AVAILABLE VOICES (ElevenLabs premade, American English):
${JSON.stringify(voiceSummary, null, 2)}

Select the voice that best matches this buyer's name, professional role, and personality.
Consider: the buyer's name (often suggests gender), title (seniority level), and persona tone (e.g. aggressive, warm, rushed, analytical).

CRITICAL: In your JSON response, voice_id must be copied EXACTLY from the voice_id field above — an opaque string like "${exampleId}".
Do NOT return the name field (e.g. "Bella - Professional, Bright, Warm").

Return ONLY: {"voice_id": "<exact voice_id from list>", "reason": "<1 sentence explaining the choice>"}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    console.error("[voice-selector] GPT call failed:", await res.text());
    return null;
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const out = JSON.parse(data.choices[0].message.content) as { voice_id: string; reason: string };

  const match = resolveVoiceChoice(out.voice_id, voices);
  if (!match) {
    console.warn("[voice-selector] GPT returned unknown voice:", out.voice_id, "— using fallback");
    return null;
  }

  if (match.voice_id !== out.voice_id) {
    console.log(
      `[voice-selector] Resolved GPT label "${out.voice_id}" → voice_id ${match.voice_id} (${match.name})`,
    );
  }

  console.log(`[voice-selector] ${buyerName} (${buyerTitle}) → "${match.name}" — ${out.reason}`);
  return match.voice_id;
}

// ---------------------------------------------------------------------------
// Narrator voice (precap + walkthrough summaries)
// ---------------------------------------------------------------------------

/** Pick a neutral, professional American narrator voice for call summaries. */
async function selectNarratorWithGpt(voices: ElevenLabsVoice[]): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const voiceSummary = voices.map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    labels: v.labels,
    description: v.description ?? "",
  }));

  const exampleId = voices[0]?.voice_id ?? FALLBACK_VOICE_ID;

  const prompt = `You are selecting an ElevenLabs text-to-speech voice for a NEUTRAL NARRATOR who summarizes sales calls.

The narrator is NOT a buyer or seller — they are a professional coach explaining what happened so far in the call. The tone should be:
- Clear, warm, and authoritative
- American English
- Suitable for short 1-2 sentence summaries per tree node
- Not overly dramatic or salesy

AVAILABLE VOICES:
${JSON.stringify(voiceSummary, null, 2)}

CRITICAL: voice_id must be copied EXACTLY from the voice_id field — an opaque string like "${exampleId}".
Do NOT return the name field.

Return ONLY a JSON object: {"voice_id": "<exact voice_id>", "reason": "<1 sentence>"}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    console.error("[voice-selector] Narrator GPT call failed:", await res.text());
    return null;
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const out = JSON.parse(data.choices[0].message.content) as { voice_id: string; reason: string };
  const match = resolveVoiceChoice(out.voice_id, voices);
  if (!match) {
    console.warn("[voice-selector] Narrator GPT returned unknown voice:", out.voice_id);
    return null;
  }

  console.log(`[voice-selector] Narrator voice → "${match.name}" (${match.voice_id}) — ${out.reason}`);
  return match.voice_id;
}

/**
 * Resolve and cache the narrator voiceId used for precap + walkthrough TTS.
 * Safe to call multiple times — reads from cache after the first run.
 */
export async function ensureNarratorVoice(): Promise<string> {
  if (narratorVoiceId) return narratorVoiceId;

  try {
    const raw = await fs.readFile(NARRATOR_CACHE_PATH, "utf-8");
    const cached = JSON.parse(raw) as { voice_id: string; name?: string };
    // Reject stale cache from a failed selection (name "fallback" means GPT didn't match).
    if (cached.voice_id && cached.name && cached.name !== "fallback") {
      narratorVoiceId = cached.voice_id;
      console.log(`[voice-selector] Narrator voice loaded from cache: ${cached.name}`);
      return narratorVoiceId;
    }
    console.log("[voice-selector] Narrator cache invalid — re-selecting…");
  } catch {
    // cache miss — select below
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    narratorVoiceId = FALLBACK_VOICE_ID;
    return narratorVoiceId;
  }

  try {
    const voices = await loadVoiceCache();
    const picked = voices.length > 0 ? await selectNarratorWithGpt(voices) : null;
    if (!picked) {
      console.warn("[voice-selector] Narrator selection failed — using fallback (not cached)");
      narratorVoiceId = FALLBACK_VOICE_ID;
      return narratorVoiceId;
    }

    narratorVoiceId = picked;
    const match = voices.find((v) => v.voice_id === picked);

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
      NARRATOR_CACHE_PATH,
      JSON.stringify({ voice_id: picked, name: match?.name ?? picked }, null, 2),
    );
    console.log(`[voice-selector] Narrator voice cached: ${match?.name ?? picked}`);
  } catch (e) {
    console.error("[voice-selector] Narrator voice selection failed:", e);
    narratorVoiceId = FALLBACK_VOICE_ID;
  }

  return narratorVoiceId;
}

/** Sync accessor — returns cached narrator voice or fallback if startup hasn't finished. */
export function getNarratorVoiceId(): string {
  return narratorVoiceId ?? FALLBACK_VOICE_ID;
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Assign a voiceId to every buyer in the store that doesn't have one.
 * Runs once at server startup — async, does not block server listen.
 * Persists changes back to seed.json after all buyers are processed.
 */
export async function backfillBuyerVoices(): Promise<void> {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("[voice-selector] ELEVENLABS_API_KEY not set — skipping voice backfill");
    return;
  }

  const needsVoice = store.companies.flatMap((c) =>
    c.buyers.filter((b) => !b.voiceId),
  );

  if (needsVoice.length === 0) {
    console.log("[voice-selector] All buyers already have a voiceId — nothing to backfill");
    return;
  }

  console.log(`[voice-selector] Backfilling voices for ${needsVoice.length} buyer(s)...`);

  let voices: ElevenLabsVoice[];
  try {
    voices = await loadVoiceCache();
  } catch (e) {
    console.error("[voice-selector] Could not load voice cache:", e);
    return;
  }

  if (voices.length === 0) {
    console.warn("[voice-selector] Voice cache is empty — skipping backfill");
    return;
  }

  let changed = false;

  for (const company of store.companies) {
    for (const buyer of company.buyers) {
      if (buyer.voiceId) continue;

      const personaDesc = buyer.personaId
        ? getPersonaInfo(buyer.personaId)
        : "A professional buyer in a B2B software sales call.";

      try {
        const voiceId = await selectVoiceWithGpt(buyer.name, buyer.title, personaDesc, voices);
        buyer.voiceId = voiceId ?? FALLBACK_VOICE_ID;
        changed = true;
      } catch (e) {
        console.error(`[voice-selector] Failed for buyer ${buyer.id} (${buyer.name}):`, e);
        buyer.voiceId = FALLBACK_VOICE_ID;
        changed = true;
      }
    }
  }

  if (changed) {
    persist();
    console.log("[voice-selector] Persisted voice assignments to seed.json");
  }
}
