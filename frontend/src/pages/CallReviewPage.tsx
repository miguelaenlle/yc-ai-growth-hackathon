import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
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
  TREE,
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
import { CallTabs } from "../components/CallTabs";
import { Logo } from "../components/Logo";
import { SUMMARIZE_START_NODE_ID } from "../components/summarize/summarize_constants";
import { useSummarizePlayback } from "../components/summarize/useSummarizePlayback";
import { useSummarizeTreeAnimation } from "../components/summarize/useSummarizeTreeAnimation";
import { useCallDetail } from "../queries/useCallDetail";
import { getWalkthrough, peekWalkthrough } from "../lib/walkthroughCache";
import { participantsFor } from "../lib/placeholders";
import { formatDateTime } from "../lib/format";
import type { CallDetail, CallSummary, Outcome, WalkthroughBundle } from "../lib/types";

const nodeTypes = { call: CallNode };

/** Fallback outcome when we arrive without the list summary (deep link). */
function deriveOutcome(detail: CallDetail): Outcome {
  const real = detail.recordings.find((r) => r.isReal);
  if (!real) return "open";
  if (real.isActive) return "open";
  const final = detail.tree.nodes.find((n) => n.id === real.traversal.finalNodeId);
  if (!final) return "open";
  return final.successProbability >= 0.5 ? "won" : "lost";
}

function dateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  });
}

type SummarizeStatus = "loading" | "ready" | "playing" | "error";

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SidebarProps {
  id: string;
  summary?: CallSummary;
  company: string;
  startedAt: string;
  outcome: Outcome;
  buyerName: string;
  buyerTitle: string;
  sellerName: string;
  sellerTitle: string;
}

function Sidebar({ id, summary, company, startedAt, outcome, buyerName, buyerTitle, sellerName, sellerTitle }: SidebarProps) {
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
          {company} <span className="font-mono text-base text-text-muted">{dateOnly(startedAt)}</span>
        </h1>
      </div>

      <CallTabs id={id} state={summary ? { summary } : undefined} />

      <div className="space-y-4">
        <div>
          <div className="font-medium text-text">{buyerName}</div>
          <div className="text-sm text-text-muted">{buyerTitle}</div>
        </div>
        <div>
          <div className="font-medium text-text">{sellerName}</div>
          <div className="text-sm text-text-muted">{sellerTitle}</div>
        </div>
      </div>

      <div className="font-mono text-[13px] leading-relaxed text-text-muted">
        {formatDateTime(startedAt)}
      </div>

      <div>
        <OutcomeBadge outcome={outcome} />
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

function StateScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center bg-bg px-6 text-center text-sm text-text-muted">
      {children}
    </div>
  );
}

interface FlowProps {
  walkthrough: WalkthroughBundle | null;
  summarizeStatus: SummarizeStatus;
  onSummarize: () => void;
  onPlaybackEnd: () => void;
  /** Start a simulation from a (UI) tree node id. */
  onSimulateNode: (uiNodeId: string) => void;
  /** Watch the AI ace the path from a (UI) tree node id. */
  onWatchNode: (uiNodeId: string) => void;
}

function Flow({ walkthrough, summarizeStatus, onSummarize, onPlaybackEnd, onSimulateNode, onWatchNode }: FlowProps) {
  const isSummarizePlaying = summarizeStatus === "playing";

  // Inject per-node "simulate" + "watch AI" actions onto every node. Node ids are
  // unified with the backend tree, so every node is simulatable/watchable. CallNode
  // renders the buttons only on the focused node, so they're scoped to the selection.
  // The augmented copy is what the animation repacks each frame, so the actions
  // survive playback.
  const baseNodes = useMemo(
    () =>
      initialNodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onSimulate: () => onSimulateNode(n.id),
          onWatch: () => onWatchNode(n.id),
        },
      })),
    [onSimulateNode, onWatchNode],
  );

  const [selectedId, setSelectedId] = useState(SUMMARIZE_START_NODE_ID);
  const [nodes, setNodes] = useState(
    () => applyFocus(TREE, baseNodes, initialEdges, SUMMARIZE_START_NODE_ID).nodes,
  );
  const [edges, setEdges] = useState(
    () => applyFocus(TREE, baseNodes, initialEdges, SUMMARIZE_START_NODE_ID).edges,
  );
  const { getViewport } = useReactFlow();

  const { summarize_resetToStart } = useSummarizeTreeAnimation({
    nodes,
    selectedId,
    setSelectedId,
    setNodes,
    setEdges,
    isSummarizePlaying,
    baseNodes,
    baseEdges: initialEdges,
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
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const summary = (location.state as { summary?: CallSummary } | null)?.summary;

  const { data: detail, isLoading, isError } = useCallDetail(id);

  const company = summary?.company ?? "Call";
  const { buyer, salesperson } = participantsFor(company);

  const [walkthrough, setWalkthrough] = useState<WalkthroughBundle | null>(null);
  const [summarizeStatus, setSummarizeStatus] = useState<SummarizeStatus>("loading");

  // Prefetch the review walkthrough for the real recording once the call loads,
  // so "Summarize Call" can play instantly.
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;

    async function prefetch(d: CallDetail) {
      try {
        const realRecording = d.recordings.find((r) => r.isReal);
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

    void prefetch(detail);
    return () => {
      cancelled = true;
    };
  }, [detail]);

  const handleSummarize = useCallback(() => {
    if (!walkthrough || summarizeStatus !== "ready") return;
    setSummarizeStatus("playing");
  }, [walkthrough, summarizeStatus]);

  const handlePlaybackEnd = useCallback(() => {
    setSummarizeStatus("ready");
  }, []);

  // Simulate from a tree node. Node ids are unified with the backend, so the id
  // passes straight through to the simulate route (it resolves the start node
  // against the real tree). Forward the buyer identity for real initials.
  const handleSimulateNode = useCallback(
    (nodeId: string) => {
      navigate(`/call/${id}/simulate?from=${nodeId}`, {
        state: { buyerName: buyer.name, company },
      });
    },
    [id, navigate, buyer.name, company],
  );

  // Watch the AI ace the path from a tree node (ids pass through unchanged).
  const handleWatchNode = useCallback(
    (nodeId: string) => {
      navigate(`/call/${id}/watch?from=${nodeId}`, {
        state: { buyerName: buyer.name, company },
      });
    },
    [id, navigate, buyer.name, company],
  );

  if (isLoading) {
    return <StateScreen>Loading call…</StateScreen>;
  }
  if (isError || !detail) {
    return (
      <StateScreen>
        Couldn&apos;t load this call. Is the backend running on{" "}
        <span className="font-mono text-text-muted">:3001</span>?
      </StateScreen>
    );
  }

  const outcome = summary?.outcome ?? deriveOutcome(detail);

  return (
    <div className="flex h-screen bg-bg text-text">
      <Sidebar
        id={id!}
        summary={summary}
        company={company}
        startedAt={detail.call.startedAt}
        outcome={outcome}
        buyerName={buyer.name}
        buyerTitle={buyer.title}
        sellerName={salesperson.name}
        sellerTitle={salesperson.title}
      />
      <div className="relative flex-1">
        <ReactFlowProvider>
          <Flow
            walkthrough={walkthrough}
            summarizeStatus={summarizeStatus}
            onSummarize={handleSummarize}
            onPlaybackEnd={handlePlaybackEnd}
            onSimulateNode={handleSimulateNode}
            onWatchNode={handleWatchNode}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
