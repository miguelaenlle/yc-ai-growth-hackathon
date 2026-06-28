import type { WatchRationale } from "../hooks/useWatchSession";

const DEAL_VALUE = 48000;

function rampColor(p: number): string {
  if (p >= 0.7) return "var(--color-signal-high)";
  if (p >= 0.4) return "var(--color-signal-mid)";
  return "var(--color-signal-low)";
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function Sparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d="M12 3L13.6 8.4L19 10L13.6 11.6L12 17L10.4 11.6L5 10L10.4 8.4L12 3Z" />
    </svg>
  );
}

/** Synced "why this move works" commentary — updates per node as the AI advances
    down the optimal branch, quantifying each move on the signal ramp. */
export function WhyPanel({ rationale }: { rationale: WatchRationale | null }) {
  const deltaEv =
    rationale && rationale.prevSuccess !== null
      ? rationale.expectedValue - Math.round(rationale.prevSuccess * DEAL_VALUE)
      : 0;

  return (
    <div className="ct-ai-bg w-[340px] rounded-xl border border-accent/40 px-5 py-4 shadow-[0_0_24px_-8px_rgba(61,214,208,0.4)]">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-accent">
        <Sparkle />
        Why this works
      </div>

      {rationale ? (
        <div className="space-y-3">
          <p className="text-[15px] leading-snug text-text">{rationale.text}</p>

          <div className="flex items-center gap-3 border-t border-border-strong/60 pt-3 font-mono text-sm tabular-nums">
            <span className="text-text-faint">win-rate</span>
            {rationale.prevSuccess !== null && (
              <>
                <span className="text-text-muted">{pct(rationale.prevSuccess)}</span>
                <span className="text-text-faint">→</span>
              </>
            )}
            <span className="font-semibold" style={{ color: rampColor(rationale.successProbability) }}>
              {pct(rationale.successProbability)}
            </span>
            <span className="ml-auto text-text-faint">EV</span>
            <span className="text-text">{money(rationale.expectedValue)}</span>
            {deltaEv > 0 && (
              <span className="text-signal-high">↑{money(deltaEv)}</span>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-muted">The AI is working through the call…</p>
      )}
    </div>
  );
}
