import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams, useLocation } from "react-router-dom";
import { useCallDetail } from "../queries/useCallDetail";
import { useMockSession } from "../hooks/useMockSession";
import { buildTreeViewWithExtras } from "../lib/treeView";
import { CallTree } from "../components/tree/CallTree";
import { participantsFor } from "../lib/placeholders";

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
          "flex h-64 w-64 items-center justify-center rounded-full bg-text/90 " +
          "text-[64px] font-bold tracking-tight text-bg select-none transition-all duration-200 " +
          (active ? "ring-4 ring-accent ring-offset-4 ring-offset-bg " : "") +
          (active && speaking
            ? "shadow-[0_0_60px_-4px_rgba(61,214,208,0.85)]"
            : active
              ? "shadow-[0_0_36px_-8px_rgba(61,214,208,0.5)]"
              : "")
        }
      >
        {content}
      </div>
      {caption && <span className="text-sm text-text-muted">{caption}</span>}
    </div>
  );
}

function StatusPill({ label, tone = "idle" }: { label: string; tone?: "idle" | "live" }) {
  return (
    <div className="flex items-center gap-2.5 rounded-full border border-border-strong bg-surface/90 px-5 py-2.5 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-sm">
      <span
        className={
          "h-2.5 w-2.5 rounded-full " +
          (tone === "live" ? "bg-signal-high animate-pulse" : "bg-accent animate-glow-pulse")
        }
      />
      <span className="text-sm font-medium text-text">{label}</span>
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

  // Use the call's mock recording — the WS handler resolves the tree from it.
  const recordingId = useMemo(() => {
    if (!detail) return undefined;
    return detail.recordings.find((r) => !r.isReal)?.id ?? detail.recordings[0]?.id;
  }, [detail]);
  const currentNodeId = from ?? detail?.tree.rootNodeId;

  const buyerName =
    navState?.buyerName ??
    (navState?.company ? participantsFor(navState.company).buyer.name : "Buyer");

  const session = useMockSession({
    recordingId,
    currentNodeId,
    enabled: !!recordingId && !!currentNodeId,
  });

  // Tree, with any nodes the live session created grafted on; focus follows the
  // active node in real time.
  const view = useMemo(
    () => (detail ? buildTreeViewWithExtras(detail, session.newNodes) : null),
    [detail, session.newNodes],
  );

  // Timer counts up once the interactive phase begins; Pause freezes it.
  const [seconds, setSeconds] = useState(0);
  const paused = session.muted;
  const live = session.phase === "live";
  const ended = session.phase === "ended";
  const running = live && !paused;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const buyerSpeaking = session.aiSpeaking;
  const yourTurn = live && !buyerSpeaking && !paused;

  const overlayLabel =
    session.phase === "connecting"
      ? "Connecting…"
      : session.phase === "precap"
        ? "Going over intro"
        : null;

  const endCall = () => {
    session.stop();
    navigate(-1);
  };

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      {/* Top bar — timer left, controls right */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-8 py-5">
        <span className="font-mono text-2xl tabular-nums text-text">{mmss(seconds)}</span>
        <div className="flex items-center gap-3">
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
        <div className="relative flex flex-1 items-center justify-center gap-20">
          <Avatar
            content={initials(buyerName)}
            caption={buyerName}
            active={buyerSpeaking}
            speaking={buyerSpeaking}
          />
          <Avatar content="You" active={yourTurn} speaking={yourTurn} />

          {/* Precap / connecting indicator overlaid on the avatars */}
          {overlayLabel && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <StatusPill label={overlayLabel} />
            </div>
          )}

          {/* Turn indicator once the conversation is live */}
          {live && (
            <div className="pointer-events-none absolute bottom-12 left-1/2 -translate-x-1/2">
              <StatusPill
                label={buyerSpeaking ? `${buyerName} is speaking…` : "Your turn — start talking"}
                tone="live"
              />
            </div>
          )}

          {/* Conversation over */}
          {ended && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/80 backdrop-blur-[2px]">
              <p className="text-lg font-semibold text-text">Conversation ended</p>
              <button
                onClick={() => navigate(-1)}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
              >
                Back to review
              </button>
            </div>
          )}

          {/* Error state */}
          {session.phase === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/80 px-8 text-center">
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

        <aside className="flex w-[42%] shrink-0 flex-col border-l border-border bg-surface">
          <div className="relative flex-1">
            {view && (
              <CallTree
                root={view.root}
                nodes={view.nodes}
                edges={view.edges}
                rootId={view.rootId}
                focusId={session.activeNodeId}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
