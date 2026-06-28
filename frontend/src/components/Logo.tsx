/** CallTree wordmark — a small branching mark + "CallTree" in Space Grotesk.
    The node dots use the signal ramp (red→amber→green) as a quiet nod to what
    the product measures; the wordmark stays neutral. */
export function Logo() {
  return (
    <div className="flex items-center gap-2.5 select-none">
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
  );
}
