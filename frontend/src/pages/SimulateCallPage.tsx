import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams, useLocation } from "react-router-dom";
import { useCallDetail } from "../queries/useCallDetail";
import { usePersonas } from "../queries/usePersonas";
import { useMockAnalysis } from "../queries/useMockAnalysis";
import { useMockSession } from "../hooks/useMockSession";
import { buildTreeViewWithExtras } from "../lib/treeView";
import { CallTree } from "../components/tree/CallTree";
import { participantsFor } from "../lib/placeholders";
import type { MockCallAnalysis } from "../lib/types";

/** "John Doe" → "JD" (first letters of the first two words). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function Avatar({
  content,
  caption,
  active,
  speaking,
}: {
  content: string;
  caption?: string;
  active?: boolean;
  speaking?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className={
          "flex h-44 w-44 items-center justify-center rounded-full bg-text/90 " +
          "text-[44px] font-bold tracking-tight text-bg select-none transition-all duration-200 " +
          (active ? "ring-4 ring-accent ring-offset-4 ring-offset-bg " : "") +
          (active && speaking
            ? "shadow-[0_0_48px_-4px_rgba(61,214,208,0.85)]"
            : active
              ? "shadow-[0_0_30px_-8px_rgba(61,214,208,0.5)]"
              : "")
        }
      >
        {content}
      </div>
      {caption && <span className="text-sm text-text-muted">{caption}</span>}
    </div>
  );
}

function StatusPill({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-full border border-border-strong bg-surface/90 px-5 py-2.5 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-sm">
      <span className="h-2.5 w-2.5 animate-glow-pulse rounded-full bg-accent" />
      <span className="text-sm font-medium text-text">{label}</span>
    </div>
  );
}

const OUTCOME_BADGE: Record<MockCallAnalysis["outcome"], { label: string; cls: string }> = {
  won: { label: "Closed", cls: "border-accent/50 bg-accent-quiet text-accent" },
  lost: { label: "Lost", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
  open: { label: "Open", cls: "border-border-strong bg-surface text-text-muted" },
};

/** Small post-call analysis card shown when a human practice call ends. */
function AnalysisPopup({
  analysis,
  loading,
  failed,
  startNodeId,
  onWatchAi,
  onBack,
}: {
  analysis: MockCallAnalysis | undefined;
  loading: boolean;
  failed: boolean;
  startNodeId: string | undefined;
  onWatchAi: () => void;
  onBack: () => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-bg/70 px-6 backdrop-blur-md">
      <div className="w-full max-w-md rounded-2xl border border-border-strong bg-surface/95 p-6 shadow-[0_8px_40px_rgba(0,0,0,0.6)]">
        {loading || !analysis ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <span className="h-2.5 w-2.5 animate-glow-pulse rounded-full bg-accent" />
            <p className="text-sm text-text-muted">Analyzing your call…</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text">Call analysis</h2>
              <span
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium " +
                  OUTCOME_BADGE[analysis.outcome].cls
                }
              >
                {OUTCOME_BADGE[analysis.outcome].label}
              </span>
            </div>

            <p className="text-sm leading-relaxed text-text">{analysis.summary}</p>

            <div className="mt-4 space-y-2">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 text-accent">✓</span>
                <p className="text-sm text-text">{analysis.topStrength}</p>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 text-red-300">✗</span>
                <p className="text-sm text-text">{analysis.topWeakness}</p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-accent/40 bg-accent-quiet px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-accent/80">
                vs how you usually do
              </p>
              <p className="mt-1 text-sm font-medium text-text">{analysis.comparisonLine}</p>
            </div>

            {failed && (
              <p className="mt-3 text-xs text-text-muted">
                (The coaching model was unavailable, so this is a basic recap.)
              </p>
            )}
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-3">
          {startNodeId && (
            <button
              onClick={onWatchAi}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
            >
              See how the AI would've done it
            </button>
          )}
          <button
            onClick={onBack}
            className="rounded-md border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:border-border-strong hover:text-text"
          >
            Back to review
          </button>
        </div>
      </div>
    </div>
  );
}

export function SimulateCallPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const from = params.get("from") ?? undefined;
  const location = useLocation();
  const navState = (location.state as { buyerName?: string; company?: string } | null) ?? null;

  const { data: detail } = useCallDetail(id);
  const { data: personas } = usePersonas();

  // Which buyer persona the AI plays — chosen in the ready overlay, threaded into
  // both the live session and the post-call analysis.
  const [personaId, setPersonaId] = useState("buy_polly");

  // Use the call's mock recording — the WS handler resolves the tree from it.
  const recordingId = useMemo(() => {
    if (!detail) return undefined;
    return detail.recordings.find((r) => !r.isReal)?.id ?? detail.recordings[0]?.id;
  }, [detail]);
  const startNodeId = from ?? detail?.tree.rootNodeId;

  const buyerName =
    navState?.buyerName ??
    (navState?.company ? participantsFor(navState.company).buyer.name : "Buyer");

  // The AI buyer always opens the turn. The precap narrates the path through the
  // start node inclusive, so by the time the mic is live the buyer should speak
  // the natural next line rather than waiting on the user (server VAD).
  const buyerFirst = true;

  const session = useMockSession({
    recordingId,
    currentNodeId: startNodeId,
    buyerFirst,
    personaId,
    enabled: !!recordingId && !!startNodeId,
  });

  const phase = session.phase;
  const live = phase === "live";
  const ready = phase === "ready";
  const ended = phase === "ended";

  // Post-call analysis — fire once when a real practice conversation ends.
  const analysis = useMockAnalysis();
  const analysisFiredRef = useRef(false);
  const { liveStarted } = session;
  const analyzed = ended && liveStarted; // a real conversation happened
  useEffect(() => {
    if (analyzed && recordingId && !analysisFiredRef.current) {
      analysisFiredRef.current = true;
      analysis.mutate({ recordingId, personaId });
    }
  }, [analyzed, recordingId, personaId, analysis]);

  // Terminal leaves of the *original* tree — reaching one means the path played
  // out (a sale made / lost / outcome), so the conversation is over.
  const leafIds = useMemo(
    () =>
      new Set(
        (detail?.tree.nodes ?? [])
          .filter((n) => n.childIds.length === 0)
          .map((n) => n.id),
      ),
    [detail],
  );
  const { activeNodeId, stop } = session;
  useEffect(() => {
    if (live && activeNodeId && leafIds.has(activeNodeId)) stop("outcome");
  }, [live, activeNodeId, leafIds, stop]);

  // Re-center the tree on the start node when the conversation actually begins
  // (the user may have panned away while setting breakpoints).
  const [recenterTick, setRecenterTick] = useState(0);
  useEffect(() => {
    if (live) setRecenterTick((t) => t + 1);
  }, [live]);

  // Build the tree, graft live-created nodes, and badge start/breakpoint/end.
  const endId = ended ? session.activeNodeId : undefined;
  const bpKey = session.breakpoints.join(",");
  const nodes = useMemo(() => {
    if (!detail) return null;
    const view = buildTreeViewWithExtras(detail, session.newNodes);
    const bp = new Set(session.breakpoints);
    const withMarkers = view.nodes.map((n) => {
      let marker: "start" | "breakpoint" | "end" | undefined;
      if (endId && n.id === endId) marker = "end";
      else if (bp.has(n.id)) marker = "breakpoint";
      else if (n.id === startNodeId) marker = "start";
      return marker ? { ...n, data: { ...n.data, marker } } : n;
    });
    return { ...view, nodes: withMarkers };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, session.newNodes, bpKey, startNodeId, endId]);

  // Timer counts up once the conversation is live; Pause freezes it.
  const [seconds, setSeconds] = useState(0);
  const paused = session.muted;
  const running = live && !paused;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const buyerSpeaking = session.aiSpeaking;

  const overlayLabel =
    phase === "connecting"
      ? "Connecting…"
      : phase === "precap"
        ? "Going over intro"
        : null;

  const endReasonText =
    session.endReason === "breakpoint"
      ? "Breakpoint reached."
      : session.endReason === "outcome"
        ? "The conversation reached a final outcome."
        : "The call ended.";

  const endCall = () => {
    session.stop();
    navigate(-1);
  };

  // Hand the call to the AI from wherever the conversation currently is — it
  // takes over and plays out the optimal path from this node.
  const aiTakeOver = () => {
    const fromNode = session.activeNodeId ?? startNodeId;
    session.stop();
    navigate(`/call/${id}/watch?from=${fromNode}`, {
      state: { buyerName, company: navState?.company },
    });
  };

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      {/* Top bar — timer left, controls right */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-8 py-5">
        <span className="font-mono text-2xl tabular-nums text-text">{mmss(seconds)}</span>
        <div className="flex items-center gap-3">
          <button
            onClick={aiTakeOver}
            disabled={!live && !ready}
            className="flex items-center gap-1.5 rounded-md border border-accent/60 bg-accent-quiet px-4 py-2 text-sm font-medium text-accent transition-all duration-150 hover:bg-accent/20 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 3L13.6 8.4L19 10L13.6 11.6L12 17L10.4 11.6L5 10L10.4 8.4L12 3Z" />
            </svg>
            Let AI take over
          </button>
          <button
            onClick={() => session.setMuted(!session.muted)}
            disabled={!live}
            className="w-28 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={endCall}
            className="w-28 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
          >
            End call
          </button>
        </div>
      </header>

      {/* Body — avatars left, live tree right */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex flex-1 items-center justify-center gap-12">
          <Avatar
            content={initials(buyerName)}
            caption={buyerName}
            active={buyerSpeaking}
            speaking={buyerSpeaking}
          />
          <Avatar content="You" />

          {/* Precap / connecting indicator — blur the avatars behind it */}
          {overlayLabel && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40 backdrop-blur-md">
              <StatusPill label={overlayLabel} />
            </div>
          )}

          {/* Ready — pick persona, set breakpoints, then Play (avatars blurred) */}
          {ready && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/40 backdrop-blur-md">
              <label className="flex flex-col items-center gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Buyer persona
                </span>
                <select
                  value={personaId}
                  onChange={(e) => setPersonaId(e.target.value)}
                  className="min-w-[220px] rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text shadow-sm outline-none transition-colors hover:border-accent/60 focus:border-accent"
                >
                  {(personas ?? [{ id: "buy_polly", name: "Practice Polly", description: "" }]).map(
                    (p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <button
                onClick={session.play}
                className="flex items-center gap-2 rounded-full bg-accent px-8 py-3.5 text-base font-semibold text-bg shadow-[0_4px_24px_-4px_rgba(61,214,208,0.6)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play
              </button>
              <span className="text-sm text-text-muted">
                Set breakpoints on the tree, then start the conversation
              </span>
            </div>
          )}

          {/* Conversation over — analysis popup when a real call happened, else a
              minimal notice (e.g. ended before the conversation started). */}
          {ended && analyzed && (
            <AnalysisPopup
              analysis={analysis.data}
              loading={analysis.isPending}
              failed={analysis.isError}
              startNodeId={startNodeId}
              onWatchAi={() =>
                startNodeId &&
                navigate(`/call/${id}/watch?from=${startNodeId}`, {
                  state: { buyerName, company: navState?.company },
                })
              }
              onBack={() => navigate(-1)}
            />
          )}
          {ended && !analyzed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/60 backdrop-blur-md">
              <p className="text-lg font-semibold text-text">Conversation ended</p>
              <p className="text-sm text-text-muted">{endReasonText}</p>
              <div className="mt-3 flex items-center gap-3">
                {startNodeId && (
                  <button
                    onClick={() =>
                      navigate(`/call/${id}/watch?from=${startNodeId}`, {
                        state: { buyerName, company: navState?.company },
                      })
                    }
                    className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
                  >
                    See how the AI would've done it
                  </button>
                )}
                <button
                  onClick={() => navigate(-1)}
                  className="rounded-md border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:border-border-strong hover:text-text"
                >
                  Back to review
                </button>
              </div>
            </div>
          )}

          {/* Error state */}
          {phase === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/60 px-8 text-center backdrop-blur-md">
              <p className="max-w-sm text-sm text-text-muted">
                {session.error ??
                  "Couldn't start the call. Is the backend running on :3001 with an OPENAI_API_KEY set?"}
              </p>
              <button
                onClick={() => navigate(-1)}
                className="rounded-md border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:border-border-strong hover:text-text"
              >
                Back
              </button>
            </div>
          )}
        </div>

        <aside className="flex w-[52%] shrink-0 flex-col border-l border-border bg-surface">
          <div className="relative flex-1">
            {nodes && (
              <CallTree
                root={nodes.root}
                nodes={nodes.nodes}
                edges={nodes.edges}
                rootId={nodes.rootId}
                focusId={session.activeNodeId}
                recenterToken={recenterTick}
                selectOnClick={false}
                onNodeClick={(nodeId) => session.toggleBreakpoint(nodeId)}
              />
            )}
          </div>
          {ready && (
            <p className="pb-6 pt-2 text-center text-sm text-text-muted">
              Click a decision to set a breakpoint
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
