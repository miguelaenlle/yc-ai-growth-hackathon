// Shared PCM16 (24kHz mono) audio decoding/playback for the realtime mock flows.
// The OpenAI Realtime API streams base64 PCM16 deltas; both the live-practice
// session (useMockSession) and the AI-vs-AI demo (useWatchSession) decode them
// the same way, so the decode lives here once.

/** Decode a base64 PCM16 (little-endian) chunk into normalized Float32 samples. */
export function decodePcm16ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

/**
 * Schedules gapless playback of streamed PCM16 chunks on its own AudioContext.
 * Each `play()` queues the chunk right after whatever is already scheduled so
 * deltas play back-to-back. Owns its context — call `close()` to tear down.
 */
export class Pcm16Player {
  private ctx: AudioContext;
  private nextPlayTime = 0;
  private readonly sampleRate: number;

  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.ctx = new AudioContext({ sampleRate });
    // A context created outside a user gesture can start suspended; resume so the
    // playback clock advances (visual sync relies on currentTime progressing).
    void this.ctx.resume().catch(() => {});
  }

  /** Queue a base64 PCM16 chunk; returns its duration in seconds. */
  play(b64: string): number {
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    const float32 = decodePcm16ToFloat32(b64);
    if (float32.length === 0) return 0;
    const buffer = this.ctx.createBuffer(1, float32.length, this.sampleRate);
    buffer.copyToChannel(float32, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startTime = Math.max(this.ctx.currentTime, this.nextPlayTime);
    source.start(startTime);
    this.nextPlayTime = startTime + buffer.duration;
    return buffer.duration;
  }

  /** Seconds of audio still queued ahead of the playhead (≥ 0). */
  get queuedAhead(): number {
    return Math.max(0, this.nextPlayTime - this.ctx.currentTime);
  }

  close(): void {
    this.ctx.close().catch(() => {});
  }
}
