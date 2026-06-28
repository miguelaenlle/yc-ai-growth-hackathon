import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams, useLocation } from "react-router-dom";
import { useCallDetail } from "../queries/useCallDetail";
import { useWatchSession } from "../hooks/useWatchSession";
import { buildTreeViewWithExtras } from "../lib/treeView";
import { CallTree } from "../components/tree/CallTree";
import { WhyPanel } from "../components/WhyPanel";
import { participantsFor } from "../lib/placeholders";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function Avatar({
  content,
  caption,
  speaking,
}: {
  content: string;
  caption?: string;
  speaking?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={
          "flex h-36 w-36 items-center justify-center rounded-full bg-text/90 " +
          "text-[40px] font-bold tracking-tight text-bg select-none transition-all duration-200 " +
          (speaking
            ? "ring-4 ring-accent ring-offset-4 ring-offset-bg shadow-[0_0_48px_-4px_rgba(61,214,208,0.85)]"
            : "")
        }
      >
        {content}
      </div>
      {caption && <span className="text-sm text-text-muted">{caption}</span>}
    </div>
  );
}

export function WatchAiPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const from = params.get("from") ?? undefined;
  const location = useLocation();
  const navState = (location.state as { buyerName?: string; company?: string } | null) ?? null;

  const { data: detail } = useCallDetail(id);

  // Any of the call's recordings resolves the same tree server-side.
  const recordingId = useMemo(() => {
    if (!detail) return undefined;
    return detail.recordings.find((r) => !r.isReal)?.id ?? detail.recordings[0]?.id;
  }, [detail]);
  const fromNodeId = from ?? detail?.tree.rootNodeId;

  const buyerName =
    navState?.buyerName ??
    (navState?.company ? participantsFor(navState.company).buyer.name : "Buyer");

  const session = useWatchSession({
    recordingId,
    fromNodeId,
    enabled: !!recordingId && !!fromNodeId,
  });

  const nodes = useMemo(() => {
    if (!detail) return null;
    return buildTreeViewWithExtras(detail, session.newNodes);
  }, [detail, session.newNodes]);

  const phase = session.phase;

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-8 py-5">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold tracking-tight text-text">Watch the AI</span>
          <span className="flex items-center gap-1.5 rounded-full bg-accent-quiet px-2.5 py-1 text-xs font-medium text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            ideal path
          </span>
        </div>
        <button
          onClick={() => {
            session.stop();
            navigate(-1);
          }}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
        >
          Done
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left — the two AI speakers, the live caption, and the why panel */}
        <div className="relative flex flex-1 flex-col items-center justify-center gap-8 px-6">
          <div className="flex items-center gap-12">
            <Avatar content="You" caption="Rep" speaking={session.sellerSpeaking} />
            <Avatar content={initials(buyerName)} caption={buyerName} speaking={session.buyerSpeaking} />
          </div>

          <div className="min-h-[2.5rem] max-w-md text-center text-[15px] italic leading-snug text-text-muted">
            {session.lastLine && (
              <p>
                <span className="font-medium not-italic text-text">
                  {session.lastLine.speaker === "seller" ? "You" : buyerName}:
                </span>{" "}
                {session.lastLine.text}
              </p>
            )}
          </div>

          <WhyPanel rationale={session.rationale} />

          {phase === "connecting" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40 backdrop-blur-md">
              <div className="flex items-center gap-2.5 rounded-full border border-border-strong bg-surface/90 px-5 py-2.5 shadow-[0_4px_20px_rgba(0,0,0,0.5)]">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
                <span className="text-sm font-medium text-text">Setting up the AI…</span>
              </div>
            </div>
          )}

          {phase === "ended" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/60 backdrop-blur-md">
              <p className="text-lg font-semibold text-text">That's how the AI runs it</p>
              <p className="text-sm text-text-muted">Optimal path, end to end.</p>
              <button
                onClick={() => navigate(-1)}
                className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
              >
                Back
              </button>
            </div>
          )}

          {phase === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/60 px-8 text-center backdrop-blur-md">
              <p className="max-w-sm text-sm text-text-muted">
                {session.error ??
                  "Couldn't start the AI demo. Is the backend running on :3001 with an OPENAI_API_KEY set?"}
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

        {/* Right — the live tree tracing the optimal branch */}
        <aside className="relative w-[52%] shrink-0 border-l border-border bg-surface">
          {nodes && (
            <CallTree
              root={nodes.root}
              nodes={nodes.nodes}
              edges={nodes.edges}
              rootId={nodes.rootId}
              focusId={session.activeNodeId}
              selectOnClick={false}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
