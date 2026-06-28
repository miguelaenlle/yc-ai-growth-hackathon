/** The Slack mark (four-color octothorpe) — used in the "Your Org" chip. */
function SlackMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path d="M5.04 15.16a2.4 2.4 0 1 1-2.4-2.4h2.4v2.4Zm1.2 0a2.4 2.4 0 0 1 4.8 0v6a2.4 2.4 0 0 1-4.8 0v-6Z" fill="#E01E5A" />
      <path d="M8.64 5.04a2.4 2.4 0 1 1 2.4-2.4v2.4h-2.4Zm0 1.2a2.4 2.4 0 0 1 0 4.8h-6a2.4 2.4 0 0 1 0-4.8h6Z" fill="#36C5F0" />
      <path d="M18.76 8.64a2.4 2.4 0 1 1 2.4 2.4h-2.4v-2.4Zm-1.2 0a2.4 2.4 0 0 1-4.8 0v-6a2.4 2.4 0 0 1 4.8 0v6Z" fill="#2EB67D" />
      <path d="M15.16 18.76a2.4 2.4 0 1 1-2.4 2.4v-2.4h2.4Zm0-1.2a2.4 2.4 0 0 1 0-4.8h6a2.4 2.4 0 0 1 0 4.8h-6Z" fill="#ECB22E" />
    </svg>
  );
}

/** CallTree wordmark — a small branching mark + "CallTree" in Space Grotesk.
    The node dots use the signal ramp (red→amber→green) as a quiet nod to what
    the product measures; the wordmark stays neutral. Pass `org` to show a
    "Your Org" tenant chip (B2B-app style) alongside the wordmark. */
export function Logo({ org }: { org?: string }) {
  return (
    <div className="flex items-center gap-3 select-none">
      <div className="flex items-center gap-2.5">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="shrink-0"
        >
          {/* branches */}
          <path
            d="M12 6.5V12M12 12L6.5 17.5M12 12L17.5 17.5"
            stroke="var(--color-border-strong)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {/* nodes */}
          <circle cx="12" cy="5" r="2.4" fill="var(--color-signal-mid)" />
          <circle cx="6" cy="18.5" r="2.4" fill="var(--color-signal-low)" />
          <circle cx="18" cy="18.5" r="2.4" fill="var(--color-signal-high)" />
        </svg>
        <span className="font-logo text-[19px] font-semibold tracking-tight text-text">
          CallTree
        </span>
      </div>

      {org && (
        <>
          <span className="h-5 w-px bg-border-strong" aria-hidden="true" />
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1">
            <SlackMark />
            <span className="flex items-baseline gap-1.5 text-xs">
              <span className="uppercase tracking-wide text-text-faint">Your org</span>
              <span className="font-semibold text-text">{org}</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
