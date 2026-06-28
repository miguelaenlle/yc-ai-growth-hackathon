import { useMemo } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { CallTree } from "../components/tree/CallTree";
import { OutcomeBadge } from "../components/OutcomeBadge";
import { Logo } from "../components/Logo";
import { useCallDetail } from "../queries/useCallDetail";
import { buildTreeView } from "../lib/treeView";
import { participantsFor } from "../lib/placeholders";
import { formatDateTime } from "../lib/format";
import type { CallDetail, CallSummary, Outcome } from "../lib/types";

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

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SidebarProps {
  company: string;
  startedAt: string;
  outcome: Outcome;
  buyerName: string;
  buyerTitle: string;
  sellerName: string;
  sellerTitle: string;
}

function Sidebar({ company, startedAt, outcome, buyerName, buyerTitle, sellerName, sellerTitle }: SidebarProps) {
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

      {/* tabs (visual only) */}
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

function SummarizeButton() {
  return (
    <button className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]">
      Summarize Call
    </button>
  );
}

function StateScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center bg-bg px-6 text-center text-sm text-text-muted">
      {children}
    </div>
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

  const view = useMemo(() => (detail ? buildTreeView(detail) : null), [detail]);

  // Inject a per-node "simulate from here" action; CallNode renders it only on
  // the focused node, so the action is scoped to whatever node is selected. We
  // forward the buyer identity so the simulate screen can show real initials.
  const nodes = useMemo(
    () =>
      view?.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onSimulate: () =>
            navigate(`/call/${id}/simulate?from=${n.id}`, {
              state: { buyerName: buyer.name, company },
            }),
        },
      })) ?? [],
    [view, id, navigate, buyer.name, company],
  );

  if (isLoading) {
    return <StateScreen>Loading call…</StateScreen>;
  }
  if (isError || !detail || !view) {
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
        company={company}
        startedAt={detail.call.startedAt}
        outcome={outcome}
        buyerName={buyer.name}
        buyerTitle={buyer.title}
        sellerName={salesperson.name}
        sellerTitle={salesperson.title}
      />
      <div className="relative flex-1">
        <CallTree
          root={view.root}
          nodes={nodes}
          edges={view.edges}
          rootId={view.rootId}
          topRight={<SummarizeButton />}
        />
      </div>
    </div>
  );
}
