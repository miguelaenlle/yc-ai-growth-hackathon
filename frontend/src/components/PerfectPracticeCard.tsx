import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSalespeople } from "../queries/useSalespeople";
import { useRecommendedPractice } from "../queries/useRecommendedPractice";

function SparkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3L13.6 8.4L19 10L13.6 11.6L12 17L10.4 11.6L5 10L10.4 8.4L12 3Z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/**
 * System 1 — the "perfect practice call" for a selectable rep. Picks the persona
 * they perform worst against + a start node exercising their weakest skill, all
 * from real baseline stats, and one click launches the configured practice.
 */
export function PerfectPracticeCard() {
  const navigate = useNavigate();
  const { data: reps } = useSalespeople();
  const [repId, setRepId] = useState<string | undefined>(undefined);

  // Default to the first rep (sp_jane) once the list loads.
  const activeRepId = repId ?? reps?.[0]?.id;
  const { data: reco, isLoading, isError } = useRecommendedPractice(activeRepId);

  if (!reps || reps.length === 0) return null;

  const startPractice = () => {
    if (!reco) return;
    navigate(
      `/call/${reco.callId}/simulate?from=${reco.startNodeId}&persona=${reco.personaId}`,
      { state: { buyerName: reco.personaName, company: "Slack" } },
    );
  };

  return (
    <section className="mb-8 animate-fade-up rounded-xl border border-accent/30 bg-gradient-to-br from-accent-quiet/60 to-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.4)]">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-accent">
          <SparkIcon />
          <span className="text-[11px] font-semibold uppercase tracking-wide">
            Perfect practice call
          </span>
        </div>
        {/* Rep picker — all 5 reps */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {reps.map((r) => {
            const active = r.id === activeRepId;
            return (
              <button
                key={r.id}
                onClick={() => setRepId(r.id)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                  (active
                    ? "border-accent bg-accent text-bg"
                    : "border-border text-text-muted hover:border-border-strong hover:text-text")
                }
              >
                {r.name}
              </button>
            );
          })}
        </div>
      </div>

      {isLoading && (
        <div className="h-20 animate-pulse rounded-lg bg-surface-2" />
      )}

      {isError && (
        <p className="text-sm text-text-muted">
          Couldn&apos;t build a recommendation. Is the backend running on{" "}
          <span className="font-mono">:3001</span>?
        </p>
      )}

      {reco && !isLoading && !isError && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-text">
              {reco.headline}
            </h2>
            <ul className="mt-2 space-y-1">
              {reco.reasons.map((reason, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-text-muted">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-faint">
              <span className="rounded-md border border-border bg-surface px-2 py-1">
                Buyer: <span className="text-text">{reco.personaName}</span>
              </span>
              <span className="rounded-md border border-border bg-surface px-2 py-1">
                Start: <span className="text-text">{reco.startNodeTitle}</span>
              </span>
            </div>
          </div>

          <button
            onClick={startPractice}
            className="flex shrink-0 items-center gap-2 self-start rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] sm:self-auto"
          >
            <PlayIcon />
            Start this practice
          </button>
        </div>
      )}
    </section>
  );
}
