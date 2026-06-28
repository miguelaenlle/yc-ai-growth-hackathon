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
import { SUMMARIZE_START_NODE_ID } from "../components/summarize/summarize_constants";
import { useSummarizePlayback } from "../components/summarize/useSummarizePlayback";
import { useSummarizeTreeAnimation } from "../components/summarize/useSummarizeTreeAnimation";
import { fetchCallDetail } from "../lib/api";
import { getWalkthrough, peekWalkthrough } from "../lib/walkthroughCache";
import type { WalkthroughBundle } from "../lib/types";

const nodeTypes = { call: CallNode };

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

interface FlowProps {
  walkthrough: WalkthroughBundle | null;
  summarizeStatus: SummarizeStatus;
  onSummarize: () => void;
  onPlaybackEnd: () => void;
}

function Flow({ walkthrough, summarizeStatus, onSummarize, onPlaybackEnd }: FlowProps) {
  const isSummarizePlaying = summarizeStatus === "playing";
  const [selectedId, setSelectedId] = useState(SUMMARIZE_START_NODE_ID);
  const [nodes, setNodes] = useState(
    () => applyFocus(initialNodes, initialEdges, SUMMARIZE_START_NODE_ID).nodes,
  );
  const [edges, setEdges] = useState(
    () => applyFocus(initialNodes, initialEdges, SUMMARIZE_START_NODE_ID).edges,
  );
  const { getViewport } = useReactFlow();

  const { summarize_resetToStart } = useSummarizeTreeAnimation({
    nodes,
    selectedId,
    setSelectedId,
    setNodes,
    setEdges,
    isSummarizePlaying,
  });

  const handleSummarizeNodeFocus = useCallback((uiNodeId: string) => {
    setSelectedId((prev) => (prev === uiNodeId ? prev : uiNodeId));
  }, []);

  const handleSummarizeEnded = useCallback(() => {
    summarize_resetToStart();
    onPlaybackEnd();
  }, [summarize_resetToStart, onPlaybackEnd]);

  useSummarizePlayback({
    walkthrough,
    isPlaying: isSummarizePlaying,
    onNodeFocus: handleSummarizeNodeFocus,
    onEnded: handleSummarizeEnded,
  });

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
          if (isSummarizePlaying) return;
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
