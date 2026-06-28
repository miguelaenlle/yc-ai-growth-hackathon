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
  BASE_W,
  BASE_H,
  type CallNodeData,
} from "../components/tree/treeData";
import { buildTreeView, type TreeView } from "../lib/treeView";
import { applyFocus } from "../components/tree/focus";
import { CallNode } from "../components/tree/CallNode";
import { NodePreview } from "../components/tree/NodePreview";
import { CitedText } from "../components/CitationRef";
import { TreeMiniMap } from "../components/tree/TreeMiniMap";
import { CallEvaluation } from "../components/CallEvaluation";
import { CallTabs } from "../components/CallTabs";
import { Logo } from "../components/Logo";
import { SUMMARIZE_START_NODE_ID } from "../components/summarize/summarize_constants";
import { useSummarizePlayback } from "../components/summarize/useSummarizePlayback";
import { useSummarizeTreeAnimation } from "../components/summarize/useSummarizeTreeAnimation";
import { useCallDetail } from "../queries/useCallDetail";
import { useFeedback } from "../queries/useFeedback";
import { getWalkthrough, peekWalkthrough } from "../lib/walkthroughCache";
import { participantsFor } from "../lib/placeholders";
import { formatDateTime } from "../lib/format";
import type { CallDetail, CallSummary, WalkthroughBundle } from "../lib/types";

const nodeTypes = { call: CallNode };

/** Realized + best EV for the evaluation pill, derived when we arrive without
 *  the list summary (deep link). */
function evalFromDetail(detail: CallDetail): { finalEV: number; bestEV: number } {
  const bestEV = Math.max(0, ...detail.tree.nodes.map((n) => n.expectedValue));
  const real = detail.recordings.find((r) => r.isReal);
  const final = detail.tree.nodes.find((n) => n.id === real?.traversal.finalNodeId);
  return { finalEV: final?.expectedValue ?? 0, bestEV };
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
  finalEV: number;
  bestEV: number;
  buyerName: string;
  buyerTitle: string;
  sellerName: string;
  sellerTitle: string;
}

function Sidebar({ id, summary, company, startedAt, finalEV, bestEV, buyerName, buyerTitle, sellerName, sellerTitle }: SidebarProps) {
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
        <Logo org="Slack" />
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
        <CallEvaluation finalEV={finalEV} bestEV={bestEV} />
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
  /** This call's own tree, built from its CallDetail. */
  view: TreeView;
  walkthrough: WalkthroughBundle | null;
  summarizeStatus: SummarizeStatus;
  onSummarize: () => void;
  onPlaybackEnd: () => void;
  /** Start a simulation from a (UI) tree node id. */
  onSimulateNode: (uiNodeId: string) => void;
  /** Watch the AI ace the path from a (UI) tree node id. */
  onWatchNode: (uiNodeId: string) => void;
  /** System 2 — the top "start practicing here" pick, or undefined while loading. */
  recommendation?: {
    nodeId: string;
    nodeTitle: string;
    reason: string;
    citations?: import("../lib/types").Citation[];
  };
}

function Flow({ view, walkthrough, summarizeStatus, onSummarize, onPlaybackEnd, onSimulateNode, onWatchNode, recommendation }: FlowProps) {
  const isSummarizePlaying = summarizeStatus === "playing";

  // Focus starts at the canonical root (present in every per-call tree).
  const startNodeId = SUMMARIZE_START_NODE_ID;

  // Inject per-node "simulate" + "watch AI" actions onto every node. Node ids are
  // unified with the backend tree, so every node is simulatable/watchable. CallNode
  // renders the buttons only on the focused node, so they're scoped to the selection.
  // The augmented copy is what the animation repacks each frame, so the actions
  // survive playback.
  const baseNodes = useMemo(
    () =>
      view.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onSimulate: () => onSimulateNode(n.id),
          onWatch: () => onWatchNode(n.id),
          aiRecommended: recommendation?.nodeId === n.id,
        },
      })),
    [view, onSimulateNode, onWatchNode, recommendation],
  );

  const [selectedId, setSelectedId] = useState(startNodeId);
  const [nodes, setNodes] = useState(
    () => applyFocus(view.root, baseNodes, view.edges, startNodeId).nodes,
  );
  const [edges, setEdges] = useState(
    () => applyFocus(view.root, baseNodes, view.edges, startNodeId).edges,
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
    baseEdges: view.edges,
  });

  // Re-apply focus when baseNodes change (e.g. the AI-recommended badge arrives
  // once feedback loads) — the animation hook only re-applies on selectedId change.
  useEffect(() => {
    if (isSummarizePlaying) return;
    const f = applyFocus(view.root, baseNodes, view.edges, selectedId);
    setNodes(f.nodes);
    setEdges(f.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseNodes]);

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
        {recommendation && !isSummarizePlaying && (
          <Panel position="top-left" className="max-w-sm">
            <div className="rounded-xl border border-accent/40 bg-surface/95 p-4 shadow-[0_8px_40px_rgba(0,0,0,0.5)] backdrop-blur-sm">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent/80">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 3L13.6 8.4L19 10L13.6 11.6L12 17L10.4 11.6L5 10L10.4 8.4L12 3Z" />
                </svg>
                Practice from here
              </p>
              <span className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs font-medium text-accent">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                {recommendation.nodeTitle}
              </span>
              {recommendation.heading && (
                <p className="text-sm font-semibold text-text">{recommendation.heading}</p>
              )}
              {recommendation.reasons && recommendation.reasons.length > 0 ? (
                <ul className="mt-1.5 space-y-1">
                  {recommendation.reasons.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-text-muted">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                      <span>
                        <CitedText text={r} citations={recommendation.citations} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm leading-relaxed text-text-muted">
                  <CitedText text={recommendation.reason} citations={recommendation.citations} />
                </p>
              )}
              <button
                onClick={() => onSimulateNode(recommendation.nodeId)}
                className="mt-3 w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
              >
                Practice this moment
              </button>
            </div>
          </Panel>
        )}
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

  // System 2 — post-call review for the real recording, including the top
  // "start practicing here" pick blended from this call's signal + the rep's history.
  const realRecordingId = detail?.recordings.find((r) => r.isReal)?.id;
  const { data: feedback } = useFeedback(realRecordingId);

  // This call's OWN tree (a per-prospect view), not the global static tree.
  const view = useMemo(() => (detail ? buildTreeView(detail) : null), [detail]);

  const company = summary?.company ?? "Call";
  // Prefer the real per-call participants from the list summary; fall back to the
  // company placeholder on deep links that arrive without a summary.
  const fallbackPeople = participantsFor(company);
  const buyer = summary?.buyer ?? fallbackPeople.buyer;
  const salesperson = summary?.salesperson
    ? { name: summary.salesperson.name, title: fallbackPeople.salesperson.title }
    : fallbackPeople.salesperson;

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

  const derived = evalFromDetail(detail);
  const finalEV = summary?.finalEV ?? derived.finalEV;
  const bestEV = summary?.bestEV ?? derived.bestEV;

  // Resolve the recommended-start node's title from the tree for the banner.
  const recStart = feedback?.recommendedStart;
  const recNode = recStart
    ? detail.tree.nodes.find((n) => n.id === recStart.nodeId)
    : undefined;
  const recommendation =
    recStart && recNode
      ? {
          nodeId: recStart.nodeId,
          nodeTitle: recNode.title,
          heading: recStart.heading,
          reasons: recStart.reasons,
          reason: recStart.description ?? recStart.reason,
          citations: recStart.citations,
        }
      : undefined;

  return (
    <div className="flex h-screen bg-bg text-text">
      <Sidebar
        id={id!}
        summary={summary}
        company={company}
        startedAt={detail.call.startedAt}
        finalEV={finalEV}
        bestEV={bestEV}
        buyerName={buyer.name}
        buyerTitle={buyer.title}
        sellerName={salesperson.name}
        sellerTitle={salesperson.title}
      />
      <div className="relative flex-1">
        <ReactFlowProvider>
          {view && (
            <Flow
              key={id}
              view={view}
              walkthrough={walkthrough}
              summarizeStatus={summarizeStatus}
              onSummarize={handleSummarize}
              onPlaybackEnd={handlePlaybackEnd}
              onSimulateNode={handleSimulateNode}
              onWatchNode={handleWatchNode}
              recommendation={recommendation}
            />
          )}
        </ReactFlowProvider>
      </div>
    </div>
  );
}
