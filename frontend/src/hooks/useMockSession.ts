import { useEffect, useRef, useState, useCallback } from "react";

// Live mock-interview session: opens the backend WebSocket, plays the precap
// narration (opus), then streams mic audio ↔ the OpenAI Realtime buyer (PCM16
// @ 24kHz). The audio pipeline is adapted from _legacy/MockSessionHarness.tsx,
// which is the proven reference implementation.

export type SessionPhase =
  | "idle"
  | "connecting"
  | "precap"
  | "live"
  | "ended"
  | "error";

type PrecapItem =
  | { type: "node"; nodeId: string }
  | { type: "audio"; b64: string; mime: string }
  | { type: "complete" };

/** A node the live session created on the fly (a new branch). */
export interface SessionNode {
  nodeId: string;
  title: string;
  parentId: string;
}

interface Options {
  recordingId: string | undefined;
  currentNodeId: string | undefined;
  includePrecap?: boolean;
  enabled: boolean;
}

interface Session {
  phase: SessionPhase;
  error: string | null;
  muted: boolean;
  setMuted: (m: boolean) => void;
  /** AI buyer is currently producing audio (drives the speaking indicator). */
  aiSpeaking: boolean;
  /** The node the conversation is currently sitting on (drives tree focus). */
  activeNodeId: string | undefined;
  /** Nodes the session created live, to graft onto the tree. */
  newNodes: SessionNode[];
  /** Close the session and tear down audio. */
  stop: () => void;
}

const WS_BASE = `ws://${window.location.hostname}:3001`;

export function useMockSession({
  recordingId,
  currentNodeId,
  includePrecap = true,
  enabled,
}: Options): Session {
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState<string | undefined>(undefined);
  const [newNodes, setNewNodes] = useState<SessionNode[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const mutedRef = useRef(false);
  const speakingTimer = useRef<number | undefined>(undefined);

  // Precap playback queue.
  const precapQueueRef = useRef<PrecapItem[]>([]);
  const isPlayingPrecapRef = useRef(false);

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m;
    setMutedState(m);
  }, []);

  const cleanup = useCallback(() => {
    precapQueueRef.current = [];
    isPlayingPrecapRef.current = false;
    if (speakingTimer.current) window.clearTimeout(speakingTimer.current);
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    cleanup();
    setPhase((p) => (p === "error" ? p : "ended"));
  }, [cleanup]);

  // Decode + play a base64 PCM16 (24kHz mono) chunk from the realtime buyer.
  const playPCM16 = useCallback((b64: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;

    // Speaking indicator: on while deltas arrive, decays shortly after the last.
    setAiSpeaking(true);
    if (speakingTimer.current) window.clearTimeout(speakingTimer.current);
    speakingTimer.current = window.setTimeout(() => setAiSpeaking(false), 250);
  }, []);

  // Capture mic → PCM16 → base64 → input_audio_buffer.append.
  const startMicStreaming = useCallback((ws: WebSocket, stream: MediaStream) => {
    const ctx = new AudioContext({ sampleRate: 24000 });
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    source.connect(processor);
    processor.connect(ctx.destination); // required to make it process

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN || mutedRef.current) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const v = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      let binary = "";
      const bytes = new Uint8Array(pcm16.buffer);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      ws.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(binary) }),
      );
    };
  }, []);

  // Sequence precap node/audio/complete messages so narration plays in order.
  const processPrecapQueue = useCallback(() => {
    if (isPlayingPrecapRef.current || precapQueueRef.current.length === 0) return;
    const item = precapQueueRef.current.shift();
    if (!item) return;

    if (item.type === "node") {
      processPrecapQueue();
    } else if (item.type === "audio") {
      isPlayingPrecapRef.current = true;
      const advance = () => {
        isPlayingPrecapRef.current = false;
        processPrecapQueue();
      };
      try {
        const binary = atob(item.b64);
        const array = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
        const blob = new Blob([array], { type: item.mime });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = advance;
        audio.onerror = advance;
        audio.play().catch(advance);
      } catch {
        advance();
      }
    } else if (item.type === "complete") {
      setPhase("live");
      if (wsRef.current && mediaStreamRef.current) {
        startMicStreaming(wsRef.current, mediaStreamRef.current);
      }
      processPrecapQueue();
    }
  }, [startMicStreaming]);

  // Connect on enable; tear down on disable/unmount.
  useEffect(() => {
    if (!enabled || !recordingId || !currentNodeId) return;

    let cancelled = false;
    setError(null);
    setPhase("connecting");
    setActiveNodeId(currentNodeId);
    setNewNodes([]);

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (!cancelled) {
          setError("Microphone access is required to run a simulation.");
          setPhase("error");
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mediaStreamRef.current = stream;

      const url =
        `${WS_BASE}/mock/session/${recordingId}` +
        `?currentNodeId=${encodeURIComponent(currentNodeId)}` +
        `&includePrecap=${includePrecap}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        precapQueueRef.current = [];
        isPlayingPrecapRef.current = false;
        setPhase(includePrecap ? "precap" : "live");
        if (!includePrecap && mediaStreamRef.current) {
          startMicStreaming(ws, mediaStreamRef.current);
        }
      };

      ws.onmessage = (e) => {
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "precap_node":
            setActiveNodeId(msg.nodeId as string);
            precapQueueRef.current.push({ type: "node", nodeId: msg.nodeId as string });
            processPrecapQueue();
            break;
          case "precap_audio":
            precapQueueRef.current.push({
              type: "audio",
              b64: msg.b64_data as string,
              mime: "audio/webm;codecs=opus",
            });
            processPrecapQueue();
            break;
          case "precap_complete":
            precapQueueRef.current.push({ type: "complete" });
            processPrecapQueue();
            break;
          case "response.audio.delta":
          case "response.output_audio.delta":
            playPCM16(msg.delta as string);
            break;
          case "mock_node_matched":
            setActiveNodeId(msg.nodeId as string);
            break;
          case "mock_node_created":
            setNewNodes((prev) => [
              ...prev,
              {
                nodeId: msg.nodeId as string,
                title: (msg.title as string) ?? "New branch",
                parentId: msg.parentId as string,
              },
            ]);
            setActiveNodeId(msg.nodeId as string);
            break;
          case "mock_breakpoint_reached":
            setActiveNodeId(msg.nodeId as string);
            break;
          case "error":
            setError(
              typeof msg.error === "string"
                ? msg.error
                : "The simulation backend returned an error.",
            );
            break;
          default:
            break;
        }
      };

      ws.onerror = () => {
        if (!cancelled) {
          setError("Couldn't reach the simulation backend on :3001.");
          setPhase("error");
        }
      };

      ws.onclose = (ev) => {
        if (cancelled) return;
        if (ev.code === 1011) {
          setError(ev.reason || "Backend is missing its OPENAI_API_KEY.");
          setPhase("error");
        } else {
          setPhase((p) => (p === "error" ? p : "ended"));
        }
        cleanup();
      };
    })();

    return () => {
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, recordingId, currentNodeId, includePrecap]);

  return { phase, error, muted, setMuted, aiSpeaking, activeNodeId, newNodes, stop };
}
