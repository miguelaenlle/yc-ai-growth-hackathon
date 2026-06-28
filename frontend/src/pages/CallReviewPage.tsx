import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Panel,
  useReactFlow,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  initialNodes,
  initialEdges,
  BASE_W,
  BASE_H,
  type CallNodeData,
} from "../components/tree/treeData";
import { applyFocus } from "../components/tree/focus";
import { CallNode } from "../components/tree/CallNode";
import { NodePreview } from "../components/tree/NodePreview";
import { TreeMiniMap } from "../components/tree/TreeMiniMap";
import { OutcomeBadge } from "../components/OutcomeBadge";
import { Logo } from "../components/Logo";
import { fetchCallDetail } from "../lib/api";
import { getWalkthrough, peekWalkthrough } from "../lib/walkthroughCache";
import { toUiNodeId } from "../lib/nodeIdMap";
import type { WalkthroughBundle } from "../lib/types";

const nodeTypes = { call: CallNode };
const START_NODE_ID = "opening";

type SummarizeStatus = "loading" | "ready" | "playing" | "error";

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Sidebar() {
  const navigate = useNavigate();
  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-6 border-r border-border bg-bg px-6 py-6">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 self-start text-sm text-accent transition-opacity hover:opacity-80"
      >
        <BackArrow />
        Back
      </button>

      <div className="space-y-3">
        <Logo />
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Convex <span className="font-mono text-base text-text-muted">6/25/2026</span>
        </h1>
      </div>

      <div className="flex items-center gap-5 border-b border-border text-sm">
        <span className="-mb-px border-b-2 border-accent pb-2 font-medium text-text">
          CallTree
        </span>
        <span className="-mb-px border-b-2 border-transparent pb-2 text-text-faint">
          Runs
        </span>
      </div>

      <div className="space-y-4">
        <div>
          <div className="font-medium text-text">John Doe</div>
          <div className="text-sm text-text-muted">VP of Operations</div>
        </div>
        <div>
          <div className="font-medium text-text">Jane Doe</div>
          <div className="text-sm text-text-muted">Sales Representative</div>
        </div>
      </div>

      <div className="font-mono text-[13px] leading-relaxed text-text-muted">
        6/25/2026 5:00 PM –<br />
        6/25/2026 6:00 PM
      </div>

      <div>
        <OutcomeBadge outcome="lost" />
      </div>
    </aside>
  );
}

function Avatar() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border-strong bg-surface-2 font-mono text-sm font-medium text-text">
      M
    </div>
  );
}

const DURATION = 440;
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function activeCueIndex(timeline: WalkthroughBundle["timeline"], timeMs: number): number {
  let idx = 0;
  for (let i = 0; i < timeline.length; i++) {
    if (timeMs >= timeline[i].atMs) idx = i;
    else break;
  }
  return idx;
}

interface FlowProps {
  walkthrough: WalkthroughBundle | null;
  summarizeStatus: SummarizeStatus;
  onSummarize: () => void;
  onPlaybackEnd: () => void;
}

function Flow({ walkthrough, summarizeStatus, onSummarize, onPlaybackEnd }: FlowProps) {
  const [selectedId, setSelectedId] = useState(START_NODE_ID);
  const [nodes, setNodes] = useState(
    () => applyFocus(initialNodes, initialEdges, START_NODE_ID).nodes,
  );
  const [edges, setEdges] = useState(
    () => applyFocus(initialNodes, initialEdges, START_NODE_ID).edges,
  );
  const { setCenter, getZoom, getViewport, fitView } = useReactFlow();
  const first = useRef(true);
  const raf = useRef<number | undefined>(undefined);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const skipCenterRef = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const walkthroughRef = useRef(walkthrough);
  walkthroughRef.current = walkthrough;

  const [preview, setPreview] = useState<{
    data: CallNodeData;
    x: number;
    yTop: number;
    yBottom: number;
  } | null>(null);

  const onNodeEnter = (_: unknown, n: Node) => {
    const data = n.data as CallNodeData;
    if (!data.titleOnly) {
      setPreview(null);
      return;
    }
    const vp = getViewport();
    const w = n.width ?? BASE_W;
    const h = n.height ?? BASE_H;
    setPreview({
      data,
      x: (n.position.x + w / 2) * vp.zoom + vp.x,
      yTop: n.position.y * vp.zoom + vp.y,
      yBottom: (n.position.y + h) * vp.zoom + vp.y,
    });
  };

  useEffect(() => {
    const { nodes: target, edges: targetEdges } = applyFocus(
      initialNodes,
      initialEdges,
      selectedId,
    );
    setEdges(targetEdges);
    if (first.current) {
      first.current = false;
      setNodes(target);
      return;
    }
    const fromById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const start = performance.now();
    cancelAnimationFrame(raf.current!);

    const tick = (now: number) => {
      const t = easeInOut(Math.min(1, (now - start) / DURATION));
      setNodes(
        target.map((tn) => {
          const fn = fromById.get(tn.id) ?? tn;
          const tw = (tn.width ?? BASE_W), th = (tn.height ?? BASE_H);
          const fw = (fn.width ?? BASE_W), fh = (fn.height ?? BASE_H);
          const ts = (tn.data as { scale?: number }).scale ?? 1;
          const fs = (fn.data as { scale?: number }).scale ?? 1;
          return {
            ...tn,
            width: lerp(fw, tw, t),
            height: lerp(fh, th, t),
            position: {
              x: lerp(fn.position.x, tn.position.x, t),
              y: lerp(fn.position.y, tn.position.y, t),
            },
            data: { ...tn.data, scale: lerp(fs, ts, t) },
          };
        }),
      );
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    const f = target.find((n) => (n.data as { focused?: boolean }).focused);
    if (f) {
      if (skipCenterRef.current) {
        skipCenterRef.current = false;
        void fitView({ padding: 0.2, duration: DURATION });
      } else {
        setCenter(
          f.position.x + (f.width ?? BASE_W) / 2,
          f.position.y + (f.height ?? BASE_H) / 2,
          { zoom: Math.max(getZoom(), 0.85), duration: DURATION },
        );
      }
    }
    return () => cancelAnimationFrame(raf.current!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    const wt = walkthroughRef.current;
    if (!audio || !wt) return;
    const idx = activeCueIndex(wt.timeline, audio.currentTime * 1000);
    const uiId = toUiNodeId(wt.timeline[idx].nodeId);
    setSelectedId((prev) => (prev === uiId ? prev : uiId));
  }, []);

  const handleEnded = useCallback(() => {
    skipCenterRef.current = true;
    setSelectedId(START_NODE_ID);
    onPlaybackEnd();
  }, [onPlaybackEnd]);

  useEffect(() => {
    if (summarizeStatus !== "playing" || !walkthrough) return;

    const audio = new Audio(walkthrough.audioUrl);
    audioRef.current = audio;
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);

    void audio.play().catch((err) => {
      console.error("Walkthrough playback failed:", err);
      onPlaybackEnd();
    });

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
      audioRef.current = null;
    };
  }, [summarizeStatus, walkthrough, handleTimeUpdate, handleEnded, onPlaybackEnd]);

  const buttonLabel =
    summarizeStatus === "loading"
      ? "Preparing summary…"
      : summarizeStatus === "playing"
        ? "Playing…"
        : summarizeStatus === "error"
          ? "Summary unavailable"
          : "Summarize Call";

  const buttonDisabled =
    summarizeStatus === "loading" ||
    summarizeStatus === "playing" ||
    summarizeStatus === "error" ||
    !walkthrough;

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n: Node) => {
          if (summarizeStatus === "playing") return;
          setSelectedId(n.id);
        }}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseLeave={() => setPreview(null)}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.5}
          color="var(--color-border)"
        />
        <Panel position="bottom-right">
          <TreeMiniMap nodes={nodes} edges={edges} />
        </Panel>
        <Panel position="top-right" className="flex items-center gap-3">
          <button
            type="button"
            disabled={buttonDisabled}
            onClick={onSummarize}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {buttonLabel}
          </button>
          <Avatar />
        </Panel>
      </ReactFlow>
      {preview && (
        <div
          className="pointer-events-none absolute z-50"
          style={
            preview.yTop > 180
              ? {
                  left: preview.x,
                  top: preview.yTop - 12,
                  transform: "translate(-50%, -100%)",
                }
              : {
                  left: preview.x,
                  top: preview.yBottom + 12,
                  transform: "translate(-50%, 0)",
                }
          }
        >
          <NodePreview data={preview.data} />
        </div>
      )}
    </>
  );
}

export function CallReviewPage() {
  const { id: callId } = useParams<{ id: string }>();
  const [walkthrough, setWalkthrough] = useState<WalkthroughBundle | null>(null);
  const [summarizeStatus, setSummarizeStatus] = useState<SummarizeStatus>("loading");

  useEffect(() => {
    if (!callId) {
      setSummarizeStatus("error");
      return;
    }

    let cancelled = false;

    async function prefetch() {
      try {
        const detail = await fetchCallDetail(callId!);
        const realRecording = detail.recordings.find((r) => r.isReal);
        if (!realRecording) {
          if (!cancelled) setSummarizeStatus("error");
          return;
        }

        const cached = peekWalkthrough(realRecording.id, "review");
        if (cached) {
          if (!cancelled) {
            setWalkthrough(cached);
            setSummarizeStatus("ready");
          }
          return;
        }

        if (!cancelled) {
          setSummarizeStatus("loading");
          setWalkthrough(null);
        }

        const bundle = await getWalkthrough(realRecording.id, "review");
        if (!cancelled) {
          setWalkthrough(bundle);
          setSummarizeStatus("ready");
        }
      } catch (err) {
        console.error("Failed to prefetch walkthrough:", err);
        if (!cancelled) setSummarizeStatus("error");
      }
    }

    void prefetch();
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const handleSummarize = useCallback(() => {
    if (!walkthrough || summarizeStatus !== "ready") return;
    setSummarizeStatus("playing");
  }, [walkthrough, summarizeStatus]);

  const handlePlaybackEnd = useCallback(() => {
    setSummarizeStatus("ready");
  }, []);

  return (
    <div className="flex h-screen bg-bg text-text">
      <Sidebar />
      <div className="relative flex-1">
        <ReactFlowProvider>
          <Flow
            walkthrough={walkthrough}
            summarizeStatus={summarizeStatus}
            onSummarize={handleSummarize}
            onPlaybackEnd={handlePlaybackEnd}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
