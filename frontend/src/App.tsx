import { useState, useRef } from "react";

type PrecapEvent = 
  | { type: "node", nodeId: string } 
  | { type: "audio", b64: string, mime: string } 
  | { type: "complete" };

export default function App() {
  const [logs, setLogs] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
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
    const ws = new WebSocket("ws://localhost:3001/mock/session/rec_mock1?currentNodeId=n_push&includePrecap=true");
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
        } else if (msg.type === "precap_complete") {
          precapQueueRef.current.push({ type: "complete" });
          processPrecapQueue();
        } else if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
          playPCM16(msg.delta);
        } else if (msg.type === "error") {
          addLog(`[ERROR] ${JSON.stringify(msg.error)}`);
        } else {
          // Log other generic OpenAI realtime events but ignore the spammy audio ones
          if (!["response.audio.delta", "response.output_audio.delta", "input_audio_buffer.append"].includes(msg.type)) {
            addLog(`[EVENT] ${msg.type}`);
          }
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
      <div style={{
        background: "#1e1e1e",
        color: "#00ff00",
        padding: 15,
        height: 400,
        overflowY: "auto",
        fontFamily: "monospace"
      }}>
        {logs.map((log, i) => <div key={i}>{log}</div>)}
      </div>
    </div>
  );
}
