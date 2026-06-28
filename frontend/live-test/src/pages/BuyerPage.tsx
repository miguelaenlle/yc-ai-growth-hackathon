// @ts-nocheck
import { useState, useRef } from "react";
import { useParams } from "react-router-dom";

const WS_BACKEND = "ws://localhost:3001";

export function BuyerPage() {
  const { recordingId } = useParams<{ recordingId: string }>();
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const addLog = (msg: string) => setLogs(prev => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);

  const connect = async () => {
    if (connected) return;

    addLog("Requesting mic...");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
    } catch (e) {
      addLog("Mic error: " + String(e));
      return;
    }

    addLog("Connecting buyer WebSocket...");
    const ws = new WebSocket(`${WS_BACKEND}/live/buyer/${recordingId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      addLog("[WS] Connected as buyer. Streaming mic...");
      setConnected(true);
      startMicStreaming(ws, stream);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          addLog(`[YOU] ${msg.transcript}`);
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      addLog("[WS] Disconnected.");
      cleanup();
    };

    ws.onerror = () => addLog("[WS] Error.");
  };

  const disconnect = () => {
    wsRef.current?.close();
    cleanup();
  };

  const cleanup = () => {
    setConnected(false);
    processorRef.current?.disconnect();
    processorRef.current = null;
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
  };

  const startMicStreaming = (ws: WebSocket, stream: MediaStream) => {
    const ctx = new window.AudioContext({ sampleRate: 24000 });
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    source.connect(processor);
    processor.connect(ctx.destination);

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const v = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      const bytes = new Uint8Array(pcm16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(binary) }));
    };
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 40, background: "#f0fdf4", minHeight: "100vh" }}>
      <h2 style={{ marginBottom: 4 }}>🎧 Buyer</h2>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>
        Recording: <code>{recordingId}</code> — speak naturally. Your audio is streamed to the backend for transcription.
      </p>

      <div style={{ marginBottom: 24 }}>
        {!connected ? (
          <button onClick={connect} style={btn("#059669")}>Join Call as Buyer</button>
        ) : (
          <button onClick={disconnect} style={btn("#dc2626")}>Leave Call</button>
        )}
        <span style={{ marginLeft: 12, fontSize: 13, color: connected ? "#16a34a" : "#9ca3af" }}>
          {connected ? "● Mic active — speak now" : "○ Not connected"}
        </span>
      </div>

      {/* Log */}
      <div style={{ background: "#fff", border: "1px solid #d1fae5", borderRadius: 8, padding: 12 }}>
        <h3 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#374151", textTransform: "uppercase" }}>Event Log</h3>
        <div style={{ height: 300, overflowY: "auto", fontFamily: "monospace", fontSize: 12, color: "#374151" }}>
          {logs.length === 0 && <div style={{ color: "#9ca3af" }}>No events yet.</div>}
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}

const btn = (bg: string): React.CSSProperties => ({
  padding: "10px 20px",
  background: bg,
  color: "white",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 15,
});
