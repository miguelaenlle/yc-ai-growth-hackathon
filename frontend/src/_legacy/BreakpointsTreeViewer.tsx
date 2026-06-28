// @ts-nocheck
// ARCHIVED — preserved verbatim from the mock_breakpoints branch's
// frontend/src/App.tsx (breakpoints + mock-session debug viewer). Kept for
// future PRs after merging master's polished frontend. Intentionally NOT imported.
import { useState, useRef, useEffect } from "react";

const treeCss = `
  ul.tree-lines {
    padding-left: 0;
    margin: 0;
    display: flex;
    justify-content: center;
  }
  ul.tree-lines ul {
    padding-left: 0;
    margin: 0;
    display: flex;
    justify-content: center;
    padding-top: 20px;
    position: relative;
  }
  ul.tree-lines li {
    list-style-type: none;
    position: relative;
    padding: 20px 10px 0 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  
  ul.tree-lines li::before, ul.tree-lines li::after {
    content: '';
    position: absolute;
    top: 0;
    right: 50%;
    border-top: 2px solid #cbd5e1;
    width: 50%;
    height: 20px;
  }
  ul.tree-lines li::after {
    right: auto;
    left: 50%;
    border-left: 2px solid #cbd5e1;
  }
  
  ul.tree-lines li:only-child::after, ul.tree-lines li:only-child::before {
    display: none;
  }
  ul.tree-lines li:only-child {
    padding-top: 0;
  }
  
  ul.tree-lines li:first-child::before, ul.tree-lines li:last-child::after {
    border: 0 none;
  }
  ul.tree-lines li:last-child::before {
    border-right: 2px solid #cbd5e1;
  }
  
  ul.tree-lines ul::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    border-left: 2px solid #cbd5e1;
    width: 0;
    height: 20px;
    margin-left: -1px;
  }
`;

const TreeNodeView = ({ 
  node, 
  allNodes, 
  currentNodeId, 
  targetNodeIds,
  maxDepthNodeIds
}: { 
  node: any, 
  allNodes: any[], 
  currentNodeId: string,
  targetNodeIds: string[],
  maxDepthNodeIds: string[]
}) => {
  const children = allNodes.filter((n: any) => n.parentId === node.id);
  const isCurrent = node.id === currentNodeId;
  const isBreakpoint = targetNodeIds.includes(node.id);
  const isMaxDepth = maxDepthNodeIds.includes(node.id);
  
  return (
    <li>
      <div style={{
        padding: '8px 12px', 
        background: isCurrent ? '#2563eb' : '#ffffff', 
        color: isCurrent ? '#ffffff' : '#111827', 
        border: isCurrent ? '2px solid #1d4ed8' : '1px solid #d1d5db',
        borderRadius: '6px',
        display: 'inline-block',
        position: 'relative',
        zIndex: 2,
        boxShadow: isCurrent ? '0 4px 6px -1px rgba(37, 99, 235, 0.4)' : '0 1px 3px rgba(0,0,0,0.1)'
      }}>
        {isBreakpoint && (
          <div style={{
            position: 'absolute', top: -6, right: -6, width: 14, height: 14, 
            borderRadius: '50%', background: '#ef4444', border: '2px solid white',
            boxShadow: '0 0 0 2px #ef4444', zIndex: 10
          }} title="Breakpoint" />
        )}
        <div style={{ fontWeight: 'bold' }}>{node.title}</div>
        <div style={{ fontSize: '0.75em', color: isCurrent ? '#bfdbfe' : '#6b7280' }}>{node.id}</div>
      </div>
      
      {isMaxDepth && (
        <div style={{
          position: 'absolute',
          bottom: -10,
          left: '-50%',
          right: '-50%',
          borderBottom: '2px dashed #ef4444',
          zIndex: 0
        }} title="Depth Limit Breakpoint" />
      )}

      {children.length > 0 && (
        <ul>
          {children.map((child: any) => (
            <TreeNodeView 
              key={child.id} 
              node={child} 
              allNodes={allNodes} 
              currentNodeId={currentNodeId}
              targetNodeIds={targetNodeIds}
              maxDepthNodeIds={maxDepthNodeIds}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

type PrecapEvent = 
  | { type: "node", nodeId: string } 
  | { type: "audio", b64: string, mime: string } 
  | { type: "complete" };

export function BreakpointsTreeViewer() {
  const [logs, setLogs] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [breakpoint, setBreakpoint] = useState<{ reached: boolean, reason: string }>({ reached: false, reason: "" });
  const [treeNodes, setTreeNodes] = useState<any[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string>("n_push");
  const [zoom, setZoom] = useState<number>(0.6); // Default zoom level so it fits

  const targetNodesConfig = "n_less_year,n_more_year";
  const startNodeConfig = "n_push";
  const maxDepthConfig = 4;

  const [maxDepthNodeIds, setMaxDepthNodeIds] = useState<string[]>([]);

  useEffect(() => {
    fetch("http://localhost:3001/trees/tree_convex")
      .then(res => res.json())
      .then(data => {
        if (data && data.nodes) {
          setTreeNodes(data.nodes);
          
          // Calculate max depth nodes
          const depthMap = new Map<string, number>();
          const queue = [{ id: startNodeConfig, depth: 0 }];
          const maxDepthIds: string[] = [];
          
          while (queue.length > 0) {
            const { id, depth } = queue.shift()!;
            depthMap.set(id, depth);
            if (depth === maxDepthConfig) {
              maxDepthIds.push(id);
            }
            if (depth < maxDepthConfig) {
              const node = data.nodes.find((n: any) => n.id === id);
              if (node && node.childIds) {
                for (const childId of node.childIds) {
                  queue.push({ id: childId, depth: depth + 1 });
                }
              }
            }
          }
          setMaxDepthNodeIds(maxDepthIds);
        }
      })
      .catch(err => console.error("Failed to fetch tree:", err));
  }, []);
  
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  
  // Queue for precap playback
  const precapQueueRef = useRef<PrecapEvent[]>([]);
  const isPlayingPrecapRef = useRef(false);

  const addLog = (msg: string) => setLogs((prev) => [...prev, msg]);

  const connectAndStart = async () => {
    setCurrentNodeId("n_push");
    if (connected) return;

    addLog("Requesting mic permissions...");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
    } catch (e) {
      addLog("Mic error: " + String(e));
      return;
    }

    addLog("Connecting to WebSocket...");
    const wsUrl = `ws://localhost:3001/mock/session/rec_mock1?currentNodeId=${startNodeConfig}&includePrecap=true&maxDepth=${maxDepthConfig}&targetNodeIds=${targetNodesConfig}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      addLog("WS Connected. Awaiting Precap...");
      setConnected(true);
      precapQueueRef.current = [];
      isPlayingPrecapRef.current = false;
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "precap_node") {
          precapQueueRef.current.push({ type: "node", nodeId: msg.nodeId });
          processPrecapQueue();
        } else if (msg.type === "precap_audio") {
          precapQueueRef.current.push({ type: "audio", b64: msg.b64_data, mime: "audio/webm;codecs=opus" });
          processPrecapQueue();
        } else if (msg.type === "mock_breakpoint_reached") {
          addLog(`[BREAKPOINT] Reached reason: ${msg.reason}`);
          setBreakpoint({ reached: true, reason: msg.reason === "depth" ? "Maximum depth reached." : `Target node reached (${msg.nodeId}).` });
          disconnect();
        } else if (msg.type === "mock_node_matched") {
          setCurrentNodeId(msg.nodeId);
          addLog(`[TREE] Moved to existing node: ${msg.nodeId}`);
        } else if (msg.type === "mock_node_created") {
          setCurrentNodeId(msg.nodeId);
          setTreeNodes(prev => [...prev, { id: msg.nodeId, title: msg.title, description: "New branch created by LLM", parentId: msg.parentId }]);
          addLog(`[TREE] Created and moved to new node: ${msg.nodeId} (${msg.title})`);
        } else if (msg.type === "precap_complete") {
          precapQueueRef.current.push({ type: "complete" });
          processPrecapQueue();
        } else if (msg.type === "info") {
          addLog(`[INFO] ${msg.text}`);
        } else if (msg.type === "response.audio_transcript.done") {
          addLog(`[AI BUYER] ${msg.transcript}`);
        } else if (msg.type === "conversation.item.input_audio_transcription.completed") {
          addLog(`[YOU] ${msg.transcript}`);
        } else if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
          playPCM16(msg.delta);
        } else if (msg.type === "error") {
          addLog(`[ERROR] ${JSON.stringify(msg.error)}`);
        }
      } catch (err) {
        addLog("Error parsing WS message");
      }
    };

    ws.onclose = () => {
      addLog("WS Closed.");
      cleanup();
    };
  };

  const processPrecapQueue = () => {
    if (isPlayingPrecapRef.current || precapQueueRef.current.length === 0) return;
    const item = precapQueueRef.current.shift();
    if (!item) return;

    if (item.type === "node") {
      addLog(`[TREE] Moved to: ${item.nodeId}`);
      processPrecapQueue();
    } else if (item.type === "audio") {
      isPlayingPrecapRef.current = true;
      addLog("[AUDIO] Playing precap audio chunk...");
      
      const playBlob = (blob: Blob) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          isPlayingPrecapRef.current = false;
          processPrecapQueue();
        };
        audio.onerror = () => {
          isPlayingPrecapRef.current = false;
          processPrecapQueue();
        };
        audio.play().catch(() => {
          isPlayingPrecapRef.current = false;
          processPrecapQueue();
        });
      };

      try {
        const binary = atob(item.b64);
        const array = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
        const blob = new Blob([array], { type: item.mime });
        playBlob(blob);
      } catch(e) {
         addLog("[ERROR] Failed to play base64 audio.");
         isPlayingPrecapRef.current = false;
         processPrecapQueue();
      }
    } else if (item.type === "complete") {
      addLog("[INFO] Precap complete. Starting Interactive Mock...");
      if (wsRef.current && mediaStreamRef.current) {
        startMicStreaming(wsRef.current, mediaStreamRef.current);
      }
      processPrecapQueue();
    }
  };

  const disconnect = () => {
    if (wsRef.current) wsRef.current.close();
    cleanup();
  };

  const cleanup = () => {
    setConnected(false);
    precapQueueRef.current = [];
    isPlayingPrecapRef.current = false;
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  };

  const startMicStreaming = (ws: WebSocket, stream: MediaStream) => {
    const ctx = new window.AudioContext({ sampleRate: 24000 });
    audioCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    source.connect(processor);
    processor.connect(ctx.destination); // Required to make it process

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const float32Array = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(float32Array.length);
      for (let i = 0; i < float32Array.length; i++) {
        let val = Math.max(-1, Math.min(1, float32Array[i]));
        pcm16[i] = val < 0 ? val * 0x8000 : val * 0x7fff;
      }
      
      const buffer = pcm16.buffer;
      let binary = "";
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: btoa(binary)
      }));
    };
  };

  const playPCM16 = (b64: string) => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    
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
    
    // Smooth scheduling
    const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
  };

  const handleRedo = () => {
    setBreakpoint({ reached: false, reason: "" });
    setLogs([]);
    connectAndStart();
  };

  if (breakpoint.reached) {
    return (
      <div style={{ padding: 40, fontFamily: 'sans-serif', textAlign: 'center', background: '#f9fafb', height: '100vh' }}>
        <h1 style={{ color: '#111827' }}>Practice Session Ended</h1>
        <p style={{ fontSize: '1.2rem', color: '#4b5563', margin: '20px 0' }}>{breakpoint.reason}</p>
        <button 
          onClick={handleRedo} 
          style={{ padding: "12px 24px", fontSize: "1.1rem", background: "#3b82f6", color: "white", border: "none", borderRadius: "8px", cursor: "pointer", boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)" }}
        >
          Redo Practice
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, fontFamily: 'sans-serif' }}>
      <h1>Minimal Test Rig: Precap + OpenAI Realtime</h1>
      <div style={{ marginBottom: 20 }}>
        {!connected ? (
          <button onClick={connectAndStart} style={{ padding: "10px 20px" }}>Connect & Start Mock</button>
        ) : (
          <button onClick={disconnect} style={{ padding: "10px 20px", background: "red", color: "white" }}>Disconnect</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: '20px', marginTop: 20 }}>
        {/* Logs */}
        <div style={{ flex: 1, height: '400px', overflowY: 'scroll', background: '#eee', padding: 10, fontFamily: 'monospace' }}>
          {logs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>

        {/* Tree Visualization */}
        <div style={{ flex: 1, height: '600px', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #ccc', borderRadius: 4 }}>
          <div style={{ padding: '10px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Conversation Tree</h3>
            <div>
              <button onClick={() => setZoom(z => z - 0.1)} style={{ marginRight: 5 }}>Zoom Out</button>
              <button onClick={() => setZoom(z => z + 0.1)}>Zoom In</button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', position: 'relative', padding: '20px' }}>
            <style dangerouslySetInnerHTML={{ __html: treeCss }} />
            <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.2s' }}>
              <ul className="tree-lines">
                {treeNodes.filter(n => !n.parentId).map(rootNode => (
                   <TreeNodeView 
                     key={rootNode.id} 
                     node={rootNode} 
                     allNodes={treeNodes} 
                     currentNodeId={currentNodeId} 
                     targetNodeIds={targetNodesConfig.split(",")}
                     maxDepthNodeIds={maxDepthNodeIds}
                   />
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
