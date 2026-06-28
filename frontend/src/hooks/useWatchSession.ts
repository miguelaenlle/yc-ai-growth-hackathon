import { useCallback, useEffect, useRef, useState } from "react";
import { Pcm16Player } from "../lib/audioPcm";
import type { SessionNode } from "./useMockSession";

// "Watch the AI ace this path" — receive-only session. The backend plays both
// the seller and buyer over one WebSocket (role=both); we decode the
// speaker-tagged audio and surface the tree position + rationale.
//
// Two things matter here:
//  1. Teardown safety — StrictMode (and any dep change) mounts→unmounts→mounts,
//     so a torn-down socket's late events must NOT touch the live session. Each
//     effect run owns a `disposed` flag and only acts on its own `ws`.
//  2. Audio-clock sync — the realtime model generates ~3× faster than realtime,
//     so we must NOT apply visual cues when their event arrives. Instead each
//     turn's cues fire when that turn's audio actually starts playing, computed
//     from the player's queued-ahead position.

export type WatchPhase = "connecting" | "playing" | "ended" | "error";

export interface WatchRationale {
  nodeId: string;
  text: string;
  successProbability: number;
  expectedValue: number;
  prevSuccess: number | null;
  deltaWinRate: number;
}

export interface WatchLine {
  speaker: "seller" | "buyer";
  text: string;
}

interface Options {
  recordingId: string | undefined;
  fromNodeId: string | undefined;
  enabled: boolean;
}

interface WatchSession {
  phase: WatchPhase;
  error: string | null;
  activeNodeId: string | undefined;
  newNodes: SessionNode[];
  sellerSpeaking: boolean;
  buyerSpeaking: boolean;
  rationale: WatchRationale | null;
  lastLine: WatchLine | null;
  stop: () => void;
}

const WS_BASE = `ws://${window.location.hostname}:3001`;

export function useWatchSession({ recordingId, fromNodeId, enabled }: Options): WatchSession {
  const [phase, setPhase] = useState<WatchPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | undefined>(fromNodeId);
  const [newNodes, setNewNodes] = useState<SessionNode[]>([]);
  const [sellerSpeaking, setSellerSpeaking] = useState(false);
  const [buyerSpeaking, setBuyerSpeaking] = useState(false);
  const [rationale, setRationale] = useState<WatchRationale | null>(null);
  const [lastLine, setLastLine] = useState<WatchLine | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<Pcm16Player | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const stop = useCallback(() => {
    // Null the refs first so any resulting close/onclose is treated as stale.
    if (playerRef.current) {
      playerRef.current.close();
      playerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    setPhase((p) => (p === "error" ? p : "ended"));
  }, []);

  useEffect(() => {
    if (!enabled || !recordingId || !fromNodeId) return;

    // Per-run state — closures below capture THESE, so a torn-down run's late
    // events no-op instead of corrupting the next run.
    let disposed = false;
    const timeouts: number[] = [];
    let endTimer: number | undefined;
    // Absolute time (performance.now ms) at which the current turn's audio begins
    // playing — every cue for that turn is scheduled to this instant.
    let turnTarget = 0;

    setPhase("connecting");
    setError(null);
    setActiveNodeId(fromNodeId);
    setNewNodes([]);
    setRationale(null);
    setLastLine(null);
    setSellerSpeaking(false);
    setBuyerSpeaking(false);

    const player = new Pcm16Player();
    playerRef.current = player;

    // Schedule a cue to fire at an absolute target time (when its audio plays).
    const at = (targetMs: number, fn: () => void) => {
      const delay = Math.max(0, targetMs - performance.now());
      const id = window.setTimeout(() => {
        if (!disposed) fn();
      }, delay);
      timeouts.push(id);
    };

    // End only once the queued audio has actually finished playing.
    const scheduleEnd = () => {
      window.clearTimeout(endTimer);
      const check = () => {
        if (disposed) return;
        const ahead = playerRef.current?.queuedAhead ?? 0;
        if (ahead <= 0.05) {
          setSellerSpeaking(false);
          setBuyerSpeaking(false);
          setPhase((p) => (p === "error" ? p : "ended"));
        } else {
          endTimer = window.setTimeout(check, 200);
        }
      };
      endTimer = window.setTimeout(check, 200);
    };

    const url =
      `${WS_BASE}/mock/session/${recordingId}` +
      `?currentNodeId=${encodeURIComponent(fromNodeId)}&role=both`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    const stale = () => disposed || ws !== wsRef.current;

    ws.onopen = () => {
      if (stale()) return;
      setPhase("playing");
    };

    ws.onmessage = (e) => {
      if (stale()) return;
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "both_audio":
          // Decode + queue immediately; playback is the timeline everything syncs to.
          playerRef.current?.play(msg.delta as string);
          break;
        case "both_speaker": {
          // A new turn begins — its audio starts after everything already queued.
          turnTarget = performance.now() + (playerRef.current?.queuedAhead ?? 0) * 1000;
          const speaker = msg.speaker as "seller" | "buyer";
          at(turnTarget, () => {
            setSellerSpeaking(speaker === "seller");
            setBuyerSpeaking(speaker === "buyer");
          });
          break;
        }
        case "mock_node_matched": {
          const id = msg.nodeId as string;
          at(turnTarget, () => setActiveNodeId(id));
          break;
        }
        case "mock_node_created": {
          const node: SessionNode = {
            nodeId: msg.nodeId as string,
            title: (msg.title as string) ?? "New branch",
            parentId: msg.parentId as string,
          };
          // Graft into the tree right away so layout includes it, but only move
          // focus to it on the audio cue.
          setNewNodes((prev) =>
            prev.some((n) => n.nodeId === node.nodeId) ? prev : [...prev, node],
          );
          at(turnTarget, () => setActiveNodeId(node.nodeId));
          break;
        }
        case "both_rationale": {
          const r: WatchRationale = {
            nodeId: msg.nodeId as string,
            text: msg.text as string,
            successProbability: msg.successProbability as number,
            expectedValue: msg.expectedValue as number,
            prevSuccess: (msg.prevSuccess as number | null) ?? null,
            deltaWinRate: (msg.deltaWinRate as number) ?? 0,
          };
          at(turnTarget, () => setRationale(r));
          break;
        }
        case "both_transcript": {
          const line: WatchLine = {
            speaker: msg.speaker as "seller" | "buyer",
            text: msg.text as string,
          };
          at(turnTarget, () => setLastLine(line));
          break;
        }
        case "mock_complete":
          scheduleEnd();
          break;
        case "error":
          setError(typeof msg.error === "string" ? msg.error : "The AI demo failed.");
          setPhase("error");
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      if (stale()) return;
      if (phaseRef.current !== "ended") {
        setError("Couldn't reach the simulation backend on :3001.");
        setPhase("error");
      }
    };

    ws.onclose = (ev) => {
      if (stale()) return;
      if (ev.code === 1011) {
        setError(ev.reason || "Backend is missing its OPENAI_API_KEY.");
        setPhase("error");
      } else {
        scheduleEnd();
      }
    };

    return () => {
      disposed = true;
      timeouts.forEach((id) => window.clearTimeout(id));
      window.clearTimeout(endTimer);
      if (wsRef.current === ws) wsRef.current = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      player.close();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [enabled, recordingId, fromNodeId]);

  return {
    phase,
    error,
    activeNodeId,
    newNodes,
    sellerSpeaking,
    buyerSpeaking,
    rationale,
    lastLine,
    stop,
  };
}
