// @ts-nocheck
import { useState, useRef, useEffect } from "react";
import { useParams } from "react-router-dom";

const BACKEND = "http://localhost:3001";
const WS_BACKEND = "ws://localhost:3001";

type TranscriptLine = { speaker: "seller" | "buyer"; text: string; index: number };
type TreeNode = { id: string; parentId: string | null; childIds: string[]; title: string; description: string; speaker: string };
type Metrics = { confidence: number; hesitation: number; enthusiasm: number };
type AssistCard = { triggerText: string; response: string; searchedWeb: boolean } | null;

// ---------------------------------------------------------------------------
// Tree component (adapted from BreakpointsTreeViewer)
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
        padding: "8px 12px",
        background: isCurrent ? "#2563eb" : "#fff",
        color: isCurrent ? "#fff" : "#111827",
        border: isCurrent ? "2px solid #1d4ed8" : "1px solid #d1d5db",
        borderRadius: 6,
        display: "inline-block",
        zIndex: 2,
        boxShadow: isCurrent ? "0 4px 6px -1px rgba(37,99,235,0.4)" : "0 1px 3px rgba(0,0,0,0.1)",
        minWidth: 80,
        textAlign: "center",
      }}>
        <div style={{ fontWeight: "bold", fontSize: 12 }}>{node.title}</div>
        <div style={{ fontSize: 10, color: isCurrent ? "#bfdbfe" : "#9ca3af" }}>{node.speaker}</div>
      </div>
      {children.length > 0 && (
        <ul>
          {children.map(child => (
            <TreeNodeView key={child.id} node={child} allNodes={allNodes} currentNodeId={currentNodeId} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Metric bar
// ---------------------------------------------------------------------------

function MetricBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ color: "#6b7280" }}>{Math.round(value * 100)}%</span>
      </div>
      <div style={{ background: "#e5e7eb", borderRadius: 4, height: 8 }}>
        <div style={{ background: color, width: `${value * 100}%`, height: 8, borderRadius: 4, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SellerPage
// ---------------------------------------------------------------------------

export function SellerPage() {
  const { recordingId } = useParams<{ recordingId: string }>();

  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string>("");
  const [metrics, setMetrics] = useState<Metrics>({ confidence: 0.5, hesitation: 0.3, enthusiasm: 0.5 });
  const [assistCard, setAssistCard] = useState<AssistCard>(null);
  const [zoom, setZoom] = useState(0.7);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const addLog = (msg: string) => setLogs(prev => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);

  // Fetch tree on mount
  useEffect(() => {
    fetch(`${BACKEND}/recordings/${recordingId}`)
      .then(r => r.json())
      .then(rec => {
        if (rec?.treeId) {
          return fetch(`${BACKEND}/trees/${rec.treeId}`);
        }
      })
      .then(r => r?.json())
      .then(tree => {
        if (tree?.nodes) {
          setTreeNodes(tree.nodes);
          setCurrentNodeId(tree.rootNodeId);
        }
      })
      .catch(() => addLog("[WARN] Could not load tree — backend may not have this recordingId yet"));
  }, [recordingId]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // SSE — receives all LiveEvents: transcript, move, branch, metrics, notes
  const connectSSE = () => {
    if (sseRef.current) sseRef.current.close();
    const sse = new EventSource(`${BACKEND}/stream/${recordingId}`);
    sseRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "transcript") {
          const seg = event.segment;
          setTranscript(prev => [...prev, { speaker: seg.speaker, text: seg.text, index: seg.index }]);
        } else if (event.type === "move" || event.type === "branch") {
          const node = event.node;
          setCurrentNodeId(node.id);
          if (event.type === "branch") {
            setTreeNodes(prev => {
              if (prev.find(n => n.id === node.id)) return prev;
              return [...prev, node];
            });
            addLog(`[BRANCH] New node created: ${node.title}`);
          } else {
            addLog(`[MOVE] → ${node.title}`);
          }
        } else if (event.type === "metrics") {
          setMetrics(event.metrics);
        } else if (event.type === "notes") {
          // AssistCard shape: { triggerText, response, searchedWeb }
          // Falls back gracefully if backend still sends old AiNotes shape
          const notes = event.notes;
          if (notes?.response) {
            setAssistCard(notes as AssistCard);
          }
        }
      } catch (_) {}
    };

    sse.onerror = () => addLog("[SSE] Connection error — retrying...");
    addLog("[SSE] Listening for live events...");
  };

  const connectWs = async () => {
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

    addLog("Connecting seller WebSocket...");
    const ws = new WebSocket(`${WS_BACKEND}/live/seller/${recordingId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      addLog("[WS] Connected as seller. Streaming mic...");
      setConnected(true);
      startMicStreaming(ws, stream);
      connectSSE();
    };

    ws.onmessage = (e) => {
      // Backend may forward raw OpenAI Realtime events — log seller's own transcription
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
    sseRef.current?.close();
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
    <div style={{ fontFamily: "sans-serif", padding: 16, background: "#f9fafb", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>🎙 Seller — <code style={{ fontSize: 14 }}>{recordingId}</code></h2>
        {!connected ? (
          <button onClick={connectWs} style={btn("#2563eb")}>Connect & Start</button>
        ) : (
          <button onClick={disconnect} style={btn("#dc2626")}>Disconnect</button>
        )}
        <span style={{ fontSize: 12, color: connected ? "#16a34a" : "#9ca3af" }}>
          {connected ? "● Live" : "○ Not connected"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>

        {/* Column 1 — Transcript + Logs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Transcript */}
          <div style={panel}>
            <h3 style={panelTitle}>Transcript</h3>
            <div style={{ height: 240, overflowY: "auto" }}>
              {transcript.map((line, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <span style={{
                    fontWeight: "bold",
                    color: line.speaker === "seller" ? "#2563eb" : "#059669",
                    fontSize: 11,
                    textTransform: "uppercase",
                    marginRight: 6,
                  }}>
                    {line.speaker}:
                  </span>
                  <span style={{ fontSize: 13 }}>{line.text}</span>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Event log */}
          <div style={panel}>
            <h3 style={panelTitle}>Event Log</h3>
            <div style={{ height: 160, overflowY: "auto", fontFamily: "monospace", fontSize: 11, color: "#374151" }}>
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>
        </div>

        {/* Column 2 — Metrics + Assist Card */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Metrics */}
          <div style={panel}>
            <h3 style={panelTitle}>Seller Signals</h3>
            <MetricBar label="Confidence" value={metrics.confidence} color="#2563eb" />
            <MetricBar label="Hesitation" value={metrics.hesitation} color="#dc2626" />
            <MetricBar label="Enthusiasm" value={metrics.enthusiasm} color="#16a34a" />
          </div>

          {/* Assist Card */}
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
                <div style={{ fontSize: 14, lineHeight: 1.6, color: "#111827" }}>
                  {assistCard.response}
                </div>
              </>
            ) : (
              <div style={{ color: "#9ca3af", fontSize: 13 }}>Waiting for buyer to speak...</div>
            )}
          </div>
        </div>

        {/* Column 3 — Conversation Tree */}
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

const panel: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 12,
};

const panelTitle: React.CSSProperties = {
  margin: "0 0 10px 0",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const btn = (bg: string): React.CSSProperties => ({
  padding: "8px 16px",
  background: bg,
  color: "white",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
});

const smallBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "#f3f4f6",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
};
