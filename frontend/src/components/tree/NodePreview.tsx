import type { CallNodeData } from "./treeData";

function rampColor(p: number): string {
  if (p >= 0.7) return "var(--color-signal-high)";
  if (p >= 0.4) return "var(--color-signal-mid)";
  return "var(--color-signal-low)";
}

function Sparkle() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M12 3L13.6 8.4L19 10L13.6 11.6L12 17L10.4 11.6L5 10L10.4 8.4L12 3Z" fill="currentColor" />
      <path d="M18.5 14.5L19.2 16.8L21.5 17.5L19.2 18.2L18.5 20.5L17.8 18.2L15.5 17.5L17.8 16.8L18.5 14.5Z" fill="currentColor" />
    </svg>
  );
}

/** A full-size, screen-space card shown when hovering a shrunk node — mirrors
    the big-card content so it stays readable at any zoom. */
export function NodePreview({ data }: { data: CallNodeData }) {
  const isAi = data.kind === "ai";
  const actor =
    data.actor === "buyer" || data.actor === "seller" ? data.actor : undefined;
  const isSeller = actor === "seller";
  const sideColor = isAi ? "border-accent/60" : "border-border-strong";

  return (
    <div
      className={
        "w-60 animate-fade-up rounded-lg px-4 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.6)] " +
        (isAi ? "ct-ai-bg " : "bg-surface-2 ") +
        (isSeller
          ? "border-y border-r border-l-[3px] " + sideColor + " border-l-seller"
          : "border " + sideColor)
      }
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        {isAi ? (
          typeof data.visits === "number" && data.visits > 0 ? (
            <>
              <span style={{ color: rampColor(data.winRate ?? data.success ?? 0) }}>
                {Math.round((data.winRate ?? data.success ?? 0) * 100)}% win
              </span>
              <span className="text-text-faint">· {data.visits} calls</span>
            </>
          ) : (
            <>
              <span className="text-accent">
                <Sparkle />
              </span>
              <span className="text-accent">AI</span>
              {typeof data.success === "number" && (
                <span style={{ color: rampColor(data.success) }}>
                  · {Math.round(data.success * 100)}% success
                </span>
              )}
            </>
          )
        ) : (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full bg-text-muted" />
            <span className="uppercase tracking-wide text-text-muted">Real</span>
          </>
        )}
        {actor && (
          <span
            className={
              "ml-auto flex items-center gap-1 " +
              (isSeller ? "text-seller" : "text-text-muted")
            }
          >
            {isSeller ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-seller" />
            ) : (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-text-muted" />
            )}
            {actor === "seller" ? "Seller" : "Buyer"}
          </span>
        )}
      </div>

      <div className="text-[15px] font-semibold text-text">{data.title}</div>
      {data.description && (
        <div className="mt-0.5 text-[13px] leading-snug text-text-muted">
          {data.description}
        </div>
      )}
    </div>
  );
}
