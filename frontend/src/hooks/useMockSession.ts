import { useCallback, useEffect, useRef, useState } from "react";
import { decodePcm16ToFloat32 } from "../lib/audioPcm";

// Live mock-interview session. Two stages over two WebSocket connections:
//   1. precap — narrate the path root→parent of the start node (no mic). The
//      user can then set breakpoints on the tree.
//   2. live   — on Play, open a fresh socket with the chosen breakpoints as
//      `targetNodeIds`, stream the mic, and talk to the OpenAI Realtime buyer.
// The audio pipeline (PCM16 @ 24kHz in/out, opus precap) is adapted from
// _legacy/MockSessionHarness.tsx, the proven reference implementation.

export type SessionPhase =
  | "idle"
  | "connecting"
  | "precap"
  | "ready"
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

/** Why the conversation ended. */
export type EndReason = "breakpoint" | "outcome" | "disconnected" | null;

interface Options {
  recordingId: string | undefined;
  currentNodeId: string | undefined;
  includePrecap?: boolean;
  /** Have the AI buyer speak first (when starting on a buyer-spoken node). */
  buyerFirst?: boolean;
  /** Which buyer persona the AI plays (persona id, e.g. "buy_polly"). */
  personaId?: string;
  enabled: boolean;
}

interface Session {
  phase: SessionPhase;
  error: string | null;
  muted: boolean;
  setMuted: (m: boolean) => void;
  /** AI buyer is currently producing audio. */
  aiSpeaking: boolean;
  /** The node the conversation is currently on (drives tree focus). */
  activeNodeId: string | undefined;
  /** Nodes the session created live, to graft onto the tree. */
  newNodes: SessionNode[];
  /** Breakpoints the user set during the `ready` stage. */
  breakpoints: string[];
  /** Toggle a breakpoint (only effective in the `ready` stage). */
  toggleBreakpoint: (nodeId: string) => void;
  /** Begin the live conversation with the chosen breakpoints. */
  play: () => void;
  /** Close the session and tear down audio. */
  stop: (reason?: EndReason) => void;
  /** Why the conversation ended (for the ended overlay). */
  endReason: EndReason;
  /** True once the live conversation actually started (guards post-call analysis). */
  liveStarted: boolean;
}

const WS_BASE = `ws://${window.location.hostname}:3001`;

export function useMockSession({
  recordingId,
  currentNodeId,
  includePrecap = true,
  buyerFirst = false,
  personaId = "buy_polly",
  enabled,
}: Options): Session {
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState<string | undefined>(undefined);
  const [newNodes, setNewNodes] = useState<SessionNode[]>([]);
  const [breakpoints, setBreakpoints] = useState<string[]>([]);
  const [endReason, setEndReason] = useState<EndReason>(null);
  const [liveStarted, setLiveStarted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const mutedRef = useRef(false);
  const speakingTimer = useRef<number | undefined>(undefined);
  const precapQueueRef = useRef<PrecapItem[]>([]);
  const isPlayingPrecapRef = useRef(false);
  const intentionalRef = useRef(false); // suppress onclose handling for our own closes
  const bpRef = useRef<string[]>([]); // breakpoints captured for play()

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const startRef = useRef(currentNodeId);
  startRef.current = currentNodeId;
  const buyerFirstRef = useRef(buyerFirst);
  buyerFirstRef.current = buyerFirst;
  const personaIdRef = useRef(personaId);
  personaIdRef.current = personaId;
  const respondedRef = useRef(false); // buyer-first response.create sent once

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m;
    setMutedState(m);
  }, []);

  const teardownAudio = useCallback(() => {
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

  const stop = useCallback(
    (reason?: EndReason) => {
      intentionalRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      teardownAudio();
      if (reason) setEndReason((r) => r ?? reason);
      setPhase((p) => (p === "error" ? p : "ended"));
    },
    [teardownAudio],
  );

  // Decode + play a base64 PCM16 (24kHz mono) chunk from the realtime buyer.
  const playPCM16 = useCallback((b64: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const float32 = decodePcm16ToFloat32(b64);
    const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;

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
    processor.connect(ctx.destination);

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
      // Move tree focus here — sequenced with audio playback (audio items below
      // block the queue), so the tree steps node-by-node in sync with narration
      // instead of jumping ahead as the messages arrive in a burst.
      setActiveNodeId(item.nodeId);
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
        const audio = new Audio(URL.createObjectURL(blob));
        audio.onended = advance;
        audio.onerror = advance;
        audio.play().catch(advance);
      } catch {
        advance();
      }
    } else if (item.type === "complete") {
      // Intro done → wait for the user to set breakpoints and press Play. Drop
      // the precap socket so its (unused) realtime half doesn't linger.
      setPhase("ready");
      setActiveNodeId(startRef.current);
      intentionalRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
      processPrecapQueue();
    }
  }, []);

  const toggleBreakpoint = useCallback((nodeId: string) => {
    if (phaseRef.current !== "ready") return;
    setBreakpoints((prev) => {
      const next = prev.includes(nodeId)
        ? prev.filter((x) => x !== nodeId)
        : [...prev, nodeId];
      bpRef.current = next;
      return next;
    });
  }, []);

  // Begin the live conversation. Opens a fresh socket carrying the breakpoints.
  const play = useCallback(() => {
    if (phaseRef.current !== "ready") return;
    const stream = mediaStreamRef.current;
    const start = startRef.current;
    if (!stream || !recordingId || !start) {
      setError("Microphone or session is unavailable.");
      setPhase("error");
      return;
    }
    const targets = bpRef.current.join(",");
    const url =
      `${WS_BASE}/mock/session/${recordingId}` +
      `?currentNodeId=${encodeURIComponent(start)}&includePrecap=false` +
      `&personaId=${encodeURIComponent(personaIdRef.current)}` +
      (targets ? `&targetNodeIds=${encodeURIComponent(targets)}` : "");

    intentionalRef.current = false;
    respondedRef.current = false;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setPhase("live");
      setLiveStarted(true);
      setActiveNodeId(start);
      startMicStreaming(ws, stream);
    };
    ws.onmessage = (e) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "session.updated":
          // Once the backend has applied its instructions, if we're standing on
          // a buyer-spoken node, have the buyer open the turn (server VAD would
          // otherwise wait for the user). Fire exactly once.
          if (buyerFirstRef.current && !respondedRef.current) {
            respondedRef.current = true;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "response.create" }));
            }
          }
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
          setEndReason((r) => r ?? "breakpoint");
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
      if (!intentionalRef.current && phaseRef.current !== "ended") {
        setError("Couldn't reach the simulation backend on :3001.");
        setPhase("error");
      }
    };
    ws.onclose = (ev) => {
      if (intentionalRef.current) return;
      if (ev.code === 1011) {
        setError(ev.reason || "Backend is missing its OPENAI_API_KEY.");
        setPhase("error");
      } else {
        setEndReason((r) => r ?? "disconnected");
        setPhase((p) => (p === "error" ? p : "ended"));
      }
      teardownAudio();
    };
  }, [recordingId, startMicStreaming, playPCM16, teardownAudio]);

  // Open the precap socket (intro narration only, no mic).
  const connectPrecap = useCallback(() => {
    const start = startRef.current;
    if (!recordingId || !start) return;
    const url =
      `${WS_BASE}/mock/session/${recordingId}` +
      `?currentNodeId=${encodeURIComponent(start)}&includePrecap=true`;
    intentionalRef.current = false;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      precapQueueRef.current = [];
      isPlayingPrecapRef.current = false;
      setPhase("precap");
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
          // Don't focus here — focus advances when this node's audio is dequeued
          // in processPrecapQueue, keeping the tree in sync with the narration.
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
        case "error":
          setError(
            typeof msg.error === "string" ? msg.error : "Precap failed.",
          );
          break;
        default:
          break;
      }
    };
    ws.onerror = () => {
      if (!intentionalRef.current && phaseRef.current === "precap") {
        setError("Couldn't reach the simulation backend on :3001.");
        setPhase("error");
      }
    };
    ws.onclose = (ev) => {
      if (intentionalRef.current) return;
      if (ev.code === 1011) {
        setError(ev.reason || "Backend is missing its OPENAI_API_KEY.");
        setPhase("error");
      } else if (phaseRef.current === "precap" || phaseRef.current === "connecting") {
        setPhase("ended");
      }
      teardownAudio();
    };
  }, [recordingId, processPrecapQueue, teardownAudio]);

  // Acquire the mic, then start the precap (or jump straight to ready).
  useEffect(() => {
    if (!enabled || !recordingId || !currentNodeId) return;

    let cancelled = false;
    intentionalRef.current = false;
    setError(null);
    setPhase("connecting");
    setActiveNodeId(currentNodeId);
    setNewNodes([]);
    setBreakpoints([]);
    setEndReason(null);
    setLiveStarted(false);
    bpRef.current = [];
    respondedRef.current = false;

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
      if (includePrecap) connectPrecap();
      else setPhase("ready");
    })();

    return () => {
      cancelled = true;
      intentionalRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      teardownAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, recordingId, currentNodeId, includePrecap]);

  return {
    phase,
    error,
    muted,
    setMuted,
    aiSpeaking,
    activeNodeId,
    newNodes,
    breakpoints,
    toggleBreakpoint,
    play,
    stop,
    endReason,
    liveStarted,
  };
}
