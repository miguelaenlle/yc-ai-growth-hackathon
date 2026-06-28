import { useMemo, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useCallDetail } from "../queries/useCallDetail";
import { CallTabs } from "../components/CallTabs";
import { CallTree } from "../components/tree/CallTree";
import { RecordingPlayer } from "../components/RecordingPlayer";
import { Logo } from "../components/Logo";
import { buildTreeView } from "../lib/treeView";
import { participantsFor } from "../lib/placeholders";
import type { CallSummary, Recording, Tree } from "../lib/types";

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

function dateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

/** "{start node} → {Sale Closed | Deal Lost}" for a practice run. */
function runLabel(rec: Recording, tree: Tree): string {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const start = byId.get(rec.traversal.initialNodeId ?? rec.startNodeId ?? tree.rootNodeId);
  const final = byId.get(rec.traversal.finalNodeId);
  const outcome = (final?.successProbability ?? 0) >= 0.5 ? "Sale Closed" : "Deal Lost";
  return `${start?.title ?? "Start"} → ${outcome}`;
}

function StateScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center bg-bg px-6 text-center text-sm text-text-muted">
      {children}
    </div>
  );
}

function FeedbackSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-base font-semibold text-text">{title}</h2>
      <ul className="space-y-1.5">
        {items.length === 0 ? (
          <li className="text-[15px] text-text-faint">…</li>
        ) : (
          items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[15px] leading-snug text-text-muted">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-text-faint" />
              <span>{it}</span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

export function RecordingsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const summary = (location.state as { summary?: CallSummary } | null)?.summary;

  const { data: detail, isLoading, isError } = useCallDetail(id);

  // Single-company demo: company name rides in via the tab's nav state; fall back
  // to the one seeded call when deep-linked.
  const company = summary?.company ?? "Slack";
  const buyerName = participantsFor(company).buyer.name;

  // Practice runs (mocks) — the real recorded call lives on the CallTree tab.
  const runs = useMemo(
    () => (detail ? detail.recordings.filter((r) => !r.isReal) : []),
    [detail],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((r) => r.id === selectedId) ?? runs[0] ?? null;

  const view = useMemo(() => (detail ? buildTreeView(detail) : null), [detail]);

  if (isLoading) return <StateScreen>Loading recordings…</StateScreen>;
  if (isError || !detail) {
    return (
      <StateScreen>
        Couldn&apos;t load this call. Is the backend running on{" "}
        <span className="font-mono text-text-muted">:3001</span>?
      </StateScreen>
    );
  }

  const fb = selected?.aiFeedback;

  return (
    <div className="flex h-screen bg-bg text-text">
      {/* Sidebar — header, tabs, and the list of practice runs */}
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
            {company}{" "}
            <span className="font-mono text-base text-text-muted">{dateOnly(detail.call.startedAt)}</span>
          </h1>
        </div>

        <CallTabs id={id!} state={summary ? { summary } : undefined} />

        <div className="space-y-2">
          {runs.length === 0 && (
            <p className="text-sm text-text-muted">No practice runs yet.</p>
          )}
          {runs.map((rec) => {
            const active = selected?.id === rec.id;
            return (
              <button
                key={rec.id}
                onClick={() => setSelectedId(rec.id)}
                className={
                  "w-full rounded-lg border px-4 py-3 text-left transition-all duration-150 " +
                  (active
                    ? "border-accent bg-surface-2"
                    : "border-border bg-surface hover:border-border-strong hover:bg-surface-2")
                }
              >
                <div className="text-[15px] font-medium text-text">
                  {dateTime(detail.call.startedAt)}
                </div>
                <div className="mt-0.5 text-sm text-text-muted">{runLabel(rec, detail.tree)}</div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Feedback column */}
      <section className="flex w-[360px] shrink-0 flex-col gap-8 overflow-y-auto border-r border-border px-7 py-8">
        {selected ? (
          <>
            <FeedbackSection title="What went well" items={fb?.strengths ?? []} />
            <FeedbackSection title="What didn't go well" items={fb?.weaknesses ?? []} />
            <FeedbackSection
              title="What to do better next time"
              items={(fb?.practiceTargets ?? []).map((t) => t.drill)}
            />
            <button
              onClick={() => {
                const fromNode =
                  selected.startNodeId ??
                  selected.traversal.initialNodeId ??
                  detail.tree.rootNodeId;
                navigate(`/call/${id}/watch?from=${fromNode}`, {
                  state: { buyerName, company },
                });
              }}
              className="mt-1 self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
            >
              See ideal conversation
            </button>
          </>
        ) : (
          <p className="text-sm text-text-muted">Select a recording to review it.</p>
        )}
      </section>

      {/* Tree + player */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex-1">
          {view && (
            <CallTree
              root={view.root}
              nodes={view.nodes}
              edges={view.edges}
              rootId={view.rootId}
              focusId={selected?.traversal.finalNodeId}
            />
          )}
        </div>
        {selected && (
          <div className="shrink-0 border-t border-border bg-surface px-7 py-5">
            <RecordingPlayer recording={selected} buyerName={buyerName} />
          </div>
        )}
      </div>
    </div>
  );
}
