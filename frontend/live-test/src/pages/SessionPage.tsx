// @ts-nocheck
// SessionPage — single-tab live call test harness.
//
// One browser tab, one mic, one WebSocket to /live/session/:id.
// Seller always starts. Press Space or Enter to hand the turn to the next speaker.
// Each audio chunk is tagged with the current speaker before being sent:
//   { speaker: "seller"|"buyer", audio: "<base64 pcm16>" }
//
// The seller's coaching overlay (transcript, metrics, tree, assist card) is shown here.

import { useState, useRef, useEffect } from "react";
import { useParams } from "react-router-dom";

const BACKEND = "http://localhost:3001";
const WS_BACKEND = "ws://localhost:3001";
const SAMPLE_RATE = 24000; // must match OpenAI Realtime expectation

type Speaker = "seller" | "buyer";
type TranscriptLine = { speaker: Speaker; text: string; index: number };
type TreeNode = { id: string; parentId: string | null; childIds: string[]; title: string; description: string; speaker: string };
type Metrics = { confidence: number; hesitation: number; enthusiasm: number };
type AssistCard = { triggerText: string; response: string; searchedWeb: boolean } | null;

// ---------------------------------------------------------------------------
// Tree component
// ---------------------------------------------------------------------------

const treeCss = `
  ul.tree-lines { padding-left: 0; margin: 0; display: flex; justify-content: center; }
  ul.tree-lines ul { padding-left: 0; margin: 0; display: flex; justify-content: center; padding-top: 20px; position: relative; }
  ul.tree-lines li { list-style-type: none; position: relative; padding: 20px 10px 0 10px; display: flex; flex-direction: column; align-items: center; }
  ul.tree-lines li::before, ul.tree-lines li::after { content: ''; position: absolute; top: 0; right: 50%; border-top: 2px solid #cbd5e1; width: 50%; height: 20px; }
  ul.tree-lines li::after { right: auto; left: 50%; border-left: 2px solid #cbd5e1; }
  ul.tree-lines li:only-child::after, ul.tree-lines li:only-child::before { display: none; }
  ul.tree-lines li:only-child { padding-top: 0; }
  ul.tree-lines li:first-child::before, ul.tree-lines li:last-child::after { border: 0 none; }
  ul.tree-lines li:last-child::before { border-right: 2px solid #cbd5e1; }
  ul.tree-lines ul::before { content: ''; position: absolute; top: 0; left: 50%; border-left: 2px solid #cbd5e1; width: 0; height: 20px; margin-left: -1px; }
`;

function TreeNodeView({ node, allNodes, currentNodeId }: { node: TreeNode; allNodes: TreeNode[]; currentNodeId: string }) {
  const children = allNodes.filter(n => n.parentId === node.id);
  const isCurrent = node.id === currentNodeId;
  return (
    <li>
      <div style={{
        padding: "8px 12px", background: isCurrent ? "#2563eb" : "#fff",
        color: isCurrent ? "#fff" : "#111827",
        border: isCurrent ? "2px solid #1d4ed8" : "1px solid #d1d5db",
        borderRadius: 6, display: "inline-block", zIndex: 2,
        boxShadow: isCurrent ? "0 4px 6px -1px rgba(37,99,235,0.4)" : "0 1px 3px rgba(0,0,0,0.1)",
        minWidth: 80, textAlign: "center",
      }}>
        <div style={{ fontWeight: "bold", fontSize: 12 }}>{node.title}</div>
        <div style={{ fontSize: 10, color: isCurrent ? "#bfdbfe" : "#9ca3af" }}>{node.speaker}</div>
      </div>
      {children.length > 0 && (
        <ul>{children.map(c => <TreeNodeView key={c.id} node={c} allNodes={allNodes} currentNodeId={currentNodeId} />)}</ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// MetricBar
// ---------------------------------------------------------------------------

function MetricBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
        <span>{label}</span><span style={{ color: "#6b7280" }}>{Math.round(value * 100)}%</span>
      </div>
      <div style={{ background: "#e5e7eb", borderRadius: 4, height: 8 }}>
        <div style={{ background: color, width: `${value * 100}%`, height: 8, borderRadius: 4, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-mic stream — reads speaker from getSpeaker() on every audio chunk
// ---------------------------------------------------------------------------

function startMicStream(
  deviceId: string,
  getSpeaker: () => Speaker,
  ws: WebSocket,
): Promise<() => void> {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined },
  }).then(stream => {
    const ctx = new window.AudioContext({ sampleRate: SAMPLE_RATE });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
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
      ws.send(JSON.stringify({ speaker: getSpeaker(), audio: btoa(binary) }));
    };

    return () => {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach(t => t.stop());
      ctx.close();
    };
  });
}

// ---------------------------------------------------------------------------
// SessionPage
// ---------------------------------------------------------------------------

export function SessionPage() {
  const { recordingId } = useParams<{ recordingId: string }>();

  const [connected, setConnected] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<Speaker>("seller");
  const [logs, setLogs] = useState<string[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState("");
  const [metrics, setMetrics] = useState<Metrics>({ confidence: 0.5, hesitation: 0.3, enthusiasm: 0.5 });
  const [assistCard, setAssistCard] = useState<AssistCard>(null);
  const [zoom, setZoom] = useState(0.7);

  // Ref mirrors activeSpeaker so the audio callback always reads the latest value
  const activeSpeakerRef = useRef<Speaker>("seller");

  const wsRef = useRef<WebSocket | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const cleanupMicRef = useRef<(() => void) | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const addLog = (msg: string) => setLogs(prev => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);

  // Fetch tree on mount
  useEffect(() => {
    fetch(`${BACKEND}/recordings/${recordingId}`)
      .then(r => r.json())
      .then(rec => rec?.treeId ? fetch(`${BACKEND}/trees/${rec.treeId}`) : undefined)
      .then(r => r?.json())
      .then(tree => {
        if (tree?.nodes) { setTreeNodes(tree.nodes); setCurrentNodeId(tree.rootNodeId); }
      })
      .catch(() => addLog("[WARN] Could not load tree"));
  }, [recordingId]);

  // Auto-scroll transcript
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [transcript]);

  // Spacebar / Enter → hand the turn to the other speaker
  useEffect(() => {
    if (!connected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        const next: Speaker = activeSpeakerRef.current === "seller" ? "buyer" : "seller";
        activeSpeakerRef.current = next;
        setActiveSpeaker(next);
        addLog(`[TURN] Now: ${next.toUpperCase()}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connected]);

  const connectSSE = () => {
    if (sseRef.current) sseRef.current.close();
    const sse = new EventSource(`${BACKEND}/stream/${recordingId}`);
    sseRef.current = sse;
    sse.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === "transcript") {
          const s = ev.segment;
          setTranscript(prev => [...prev, { speaker: s.speaker, text: s.text, index: s.index }]);
        } else if (ev.type === "move" || ev.type === "branch") {
          setCurrentNodeId(ev.node.id);
          if (ev.type === "branch") {
            setTreeNodes(prev => prev.find(n => n.id === ev.node.id) ? prev : [...prev, ev.node]);
            addLog(`[BRANCH] ${ev.node.title}`);
          } else {
            addLog(`[MOVE] → ${ev.node.title}`);
          }
        } else if (ev.type === "metrics") {
          setMetrics(ev.metrics);
        } else if (ev.type === "notes" && ev.card?.response) {
          setAssistCard(ev.card);
        }
      } catch (_) {}
    };
    sse.onerror = () => addLog("[SSE] Connection error — retrying...");
    addLog("[SSE] Listening for live events...");
  };

  const connect = async () => {
    if (connected) return;
    // Reset to seller turn
    activeSpeakerRef.current = "seller";
    setActiveSpeaker("seller");

    addLog("Connecting to session WebSocket...");
    const ws = new WebSocket(`${WS_BACKEND}/live/session/${recordingId}`);
    wsRef.current = ws;

    ws.onopen = async () => {
      addLog("[WS] Connected. Starting mic...");
      setConnected(true);
      connectSSE();
      try {
        cleanupMicRef.current = await startMicStream(
          "",
          () => activeSpeakerRef.current,
          ws,
        );
        addLog("[MIC] Active — seller speaking first. Press Space/Enter to switch turns.");
      } catch (e) {
        addLog("[MIC] Error: " + String(e));
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          addLog(`[TRANSCRIPT] ${msg.transcript}`);
        }
      } catch (_) {}
    };

    ws.onclose = () => { addLog("[WS] Disconnected."); cleanup(); };
    ws.onerror = () => addLog("[WS] Error.");
  };

  const disconnect = () => { wsRef.current?.close(); sseRef.current?.close(); cleanup(); };

  const cleanup = () => {
    setConnected(false);
    cleanupMicRef.current?.();
    cleanupMicRef.current = null;
  };

  const speakerColor: Record<Speaker, string> = { seller: "#2563eb", buyer: "#059669" };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16, background: "#f9fafb", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>🎙 Live Session — <code style={{ fontSize: 14 }}>{recordingId}</code></h2>

        {!connected
          ? <button onClick={connect} style={btn("#2563eb")}>Start Session</button>
          : <button onClick={disconnect} style={btn("#dc2626")}>End Session</button>}

        <span style={{ fontSize: 12, color: connected ? "#16a34a" : "#9ca3af" }}>
          {connected ? "● Live" : "○ Not connected"}
        </span>

        {/* Active speaker indicator */}
        {connected && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "#fff", border: `2px solid ${speakerColor[activeSpeaker]}`,
            borderRadius: 8, padding: "6px 14px",
          }}>
            <span style={{ fontSize: 13, color: "#374151" }}>Speaking:</span>
            <strong style={{ fontSize: 15, color: speakerColor[activeSpeaker], textTransform: "uppercase" }}>
              {activeSpeaker}
            </strong>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>· Space / Enter to switch</span>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>

        {/* Col 1 — Transcript + Logs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={panel}>
            <h3 style={panelTitle}>Transcript</h3>
            <div style={{ height: 280, overflowY: "auto" }}>
              {transcript.map((line, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <span style={{
                    fontWeight: "bold", fontSize: 11, textTransform: "uppercase", marginRight: 6,
                    color: speakerColor[line.speaker],
                  }}>{line.speaker}:</span>
                  <span style={{ fontSize: 13 }}>{line.text}</span>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          <div style={panel}>
            <h3 style={panelTitle}>Event Log</h3>
            <div style={{ height: 160, overflowY: "auto", fontFamily: "monospace", fontSize: 11, color: "#374151" }}>
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>
        </div>

        {/* Col 2 — Metrics + Assist */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={panel}>
            <h3 style={panelTitle}>Seller Signals</h3>
            <MetricBar label="Confidence" value={metrics.confidence} color="#2563eb" />
            <MetricBar label="Hesitation" value={metrics.hesitation} color="#dc2626" />
            <MetricBar label="Enthusiasm" value={metrics.enthusiasm} color="#16a34a" />
          </div>

          <div style={{ ...panel, flex: 1 }}>
            <h3 style={panelTitle}>
              💡 Assist
              {assistCard?.searchedWeb && (
                <span style={{ marginLeft: 8, fontSize: 10, background: "#dbeafe", color: "#1d4ed8", padding: "2px 6px", borderRadius: 4 }}>
                  web search
                </span>
              )}
            </h3>
            {assistCard ? (
              <>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8, fontStyle: "italic" }}>
                  "{assistCard.triggerText}"
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.6, color: "#111827" }}>{assistCard.response}</div>
              </>
            ) : (
              <div style={{ color: "#9ca3af", fontSize: 13 }}>Waiting for buyer to speak...</div>
            )}
          </div>
        </div>

        {/* Col 3 — Conversation Tree */}
        <div style={{ ...panel, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ ...panelTitle, margin: 0 }}>Conversation Tree</h3>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => setZoom(z => +(z - 0.1).toFixed(1))} style={smallBtn}>−</button>
              <button onClick={() => setZoom(z => +(z + 0.1).toFixed(1))} style={smallBtn}>+</button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            <style dangerouslySetInnerHTML={{ __html: treeCss }} />
            <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center", transition: "transform 0.2s" }}>
              <ul className="tree-lines">
                {treeNodes.filter(n => !n.parentId).map(root => (
                  <TreeNodeView key={root.id} node={root} allNodes={treeNodes} currentNodeId={currentNodeId} />
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 };
const panelTitle: React.CSSProperties = { margin: "0 0 10px 0", fontSize: 13, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" };
const btn = (bg: string): React.CSSProperties => ({ padding: "8px 16px", background: bg, color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14 });
const smallBtn: React.CSSProperties = { padding: "2px 8px", background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 4, cursor: "pointer", fontSize: 14 };
