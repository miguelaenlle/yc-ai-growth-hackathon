import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { useAdminStatus, useRefreshInsights } from "../queries/useAdminInsights";

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function AdminPage() {
  const navigate = useNavigate();
  const { data: status } = useAdminStatus();
  const refresh = useRefreshInsights();

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <button
          onClick={() => navigate("/")}
          className="mb-6 flex items-center gap-1.5 text-sm text-accent transition-opacity hover:opacity-80"
        >
          <BackArrow />
          Back to calls
        </button>

        <div className="mb-8">
          <Logo org="Slack" />
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-text">Admin · Data</h1>
        <p className="mt-1 text-sm text-text-muted">
          Regenerate the data-driven practice insights (perfect practice call + practice-from-here),
          analyzed from the rep's actual calls.
        </p>

        <section className="mt-6 rounded-xl border border-border bg-surface p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                Insights
              </p>
              <p className="mt-1 text-sm text-text-muted">
                Last refreshed: <span className="text-text">{formatWhen(status?.generatedAt ?? null)}</span>
                {status?.usedLLM ? (
                  <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">LLM</span>
                ) : status?.generatedAt ? (
                  <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-muted">deterministic</span>
                ) : null}
              </p>
            </div>

            <button
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              className="flex shrink-0 items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refresh.isPending ? (
                <>
                  <span className="h-2 w-2 animate-glow-pulse rounded-full bg-bg" />
                  Refreshing…
                </>
              ) : (
                "Refresh data"
              )}
            </button>
          </div>

          {refresh.isError && (
            <p className="mt-3 text-sm text-signal-low">
              Refresh failed. Is the backend running on <span className="font-mono">:3001</span>?
            </p>
          )}

          <p className="mt-4 border-t border-border pt-4 text-[13px] leading-relaxed text-text-faint">
            Re-run this at a regular interval — say once a day, or after a batch of new calls comes in.
            There's deliberately no cron job here; keep it simple and just click the button when you want
            fresh insights. Each run re-analyzes every call, recomputes the recurring mistakes, and
            re-writes the citations.
          </p>
        </section>
      </div>
    </main>
  );
}
