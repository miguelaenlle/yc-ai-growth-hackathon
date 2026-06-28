import type { Citation } from "../lib/types";

const OUTCOME: Record<Citation["outcome"], { label: string; cls: string }> = {
  won: { label: "Won", cls: "text-signal-high" },
  lost: { label: "Lost", cls: "text-signal-low" },
  open: { label: "Open", cls: "text-text-muted" },
};

/**
 * A superscript [n] citation chip. On hover it shows a popover with the real call
 * info + the exact transcript quote where the rep made the move — so the insight
 * is traceable to an actual moment, not a vibe.
 */
export function CitationRef({ citation }: { citation: Citation }) {
  const o = OUTCOME[citation.outcome];
  return (
    <span className="group relative inline-block align-super">
      <span className="cursor-help rounded-[3px] bg-accent/15 px-1 text-[10px] font-semibold text-accent transition-colors hover:bg-accent/30">
        {citation.id}
      </span>
      <span
        className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 hidden w-72 -translate-x-1/2 group-hover:block"
        role="tooltip"
      >
        <span className="block rounded-lg border border-border-strong bg-surface/98 p-3 text-left shadow-[0_10px_30px_rgba(0,0,0,0.6)] backdrop-blur-sm">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-text">{citation.company}</span>
            <span className={"text-[11px] font-semibold uppercase tracking-wide " + o.cls}>{o.label}</span>
          </span>
          <span className="mt-0.5 block text-xs text-text-muted">
            with {citation.buyer.name} · {citation.buyer.title}
          </span>
          <span className="mt-2 block border-l-2 border-signal-low/60 pl-2">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-faint">
              You said
            </span>
            <span className="mt-0.5 block text-[13px] italic leading-snug text-text">
              “{citation.quote}”
            </span>
          </span>
          <span className="mt-2 block text-[11px] text-text-faint">
            Played <span className="text-text-muted">{citation.takenTitle}</span> ({Math.round(citation.winTaken * 100)}% win) ·{" "}
            <span className="text-text-muted">{citation.betterTitle}</span> wins {Math.round(citation.winBest * 100)}%
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * Render a reason/description string, replacing [n] tokens with hoverable
 * CitationRef chips resolved against `citations`.
 */
export function CitedText({ text, citations }: { text: string; citations?: Citation[] }) {
  if (!citations || citations.length === 0) return <>{text}</>;
  const byId = new Map(citations.map((c) => [c.id, c]));
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        if (m) {
          const c = byId.get(Number(m[1]));
          if (c) return <CitationRef key={i} citation={c} />;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
