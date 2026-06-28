// elevenlabs-tts.ts — ElevenLabs TTS WebSocket streaming helper.
//
// Sends a complete text string to the ElevenLabs stream-input WebSocket and
// calls onAudioDelta with each base64-encoded audio chunk as it arrives.
// Uses eleven_flash_v2_5 for lowest latency (WebSocket streaming compatible).

import WebSocket from "ws";

import dotenv from "dotenv";
dotenv.config();

const ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";

// PCM at 24kHz mono — matches OpenAI Realtime's audio format so the frontend's
// existing decodePcm16ToFloat32 / playPCM16 pipeline works without changes.
const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";

/** HTTP output formats for full-file synthesis (precap, walkthrough). */
export type ElevenLabsFileFormat = "mp3_44100_128" | "pcm_24000";

/**
 * Synthesize a complete audio clip via ElevenLabs REST (non-streaming).
 * Used for precap narration and walkthrough segments that are cached to disk.
 */
export async function synthesizeElevenLabsSpeech(
  voiceId: string,
  text: string,
  outputFormat: ElevenLabsFileFormat = "mp3_44100_128",
): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: outputFormat.startsWith("mp3") ? "audio/mpeg" : "application/octet-stream",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_TTS_MODEL,
    }),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Stream text through ElevenLabs TTS.
 *
 * @param voiceId    ElevenLabs voice_id to synthesise with.
 * @param text       The full buyer response text to speak.
 * @param onAudioDelta  Called with each base64-encoded audio chunk as it arrives.
 * @returns          Resolves when the stream is fully complete.
 */
export async function streamElevenLabsTTS(
  voiceId: string,
  text: string,
  onAudioDelta: (base64: string) => void,
): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  return new Promise<void>((resolve, reject) => {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${ELEVENLABS_TTS_MODEL}&output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
    const ws = new WebSocket(url);

    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    ws.on("open", () => {
      // Init: send voice settings + generation config first (text: " " is required)
      ws.send(
        JSON.stringify({
          text: " ",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            use_speaker_boost: true,
          },
          generation_config: {
            // Smaller first chunk = faster first audio byte; later chunks are larger for quality.
            chunk_length_schedule: [120, 160, 250, 290],
          },
          xi_api_key: apiKey,
        }),
      );

      // Send the text to synthesise
      ws.send(JSON.stringify({ text }));

      // Empty string signals end-of-stream to ElevenLabs
      ws.send(JSON.stringify({ text: "" }));
    });

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg["audio"] && typeof msg["audio"] === "string") {
        onAudioDelta(msg["audio"]);
      }

      if (msg["isFinal"] === true) {
        ws.close();
        done();
      }
    });

    ws.on("close", () => done());

    ws.on("error", (err) => {
      console.error("[elevenlabs-tts] WebSocket error:", err.message);
      done(err);
    });

    // Safety timeout — if ElevenLabs never fires isFinal, resolve after 30s
    // so the mock session doesn't hang indefinitely.
    setTimeout(() => {
      if (!settled) {
        console.warn("[elevenlabs-tts] Timeout waiting for isFinal — resolving anyway");
        try { ws.close(); } catch {}
        done();
      }
    }, 30_000);
  });
}
