import type { Outcome } from "../lib/types";

// Outcome rides the signal ramp — the only loud color in the UI.
const styles: Record<Outcome, { label: string; cls: string }> = {
  won: {
    label: "Won",
    cls: "text-signal-high border-signal-high/30 bg-signal-high/10",
  },
  lost: {
    label: "Lost",
    cls: "text-signal-low border-signal-low/30 bg-signal-low/10",
  },
  open: {
    label: "Open",
    cls: "text-signal-mid border-signal-mid/30 bg-signal-mid/10",
  },
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const { label, cls } = styles[outcome];
  return (
    <span
      className={
        "inline-flex shrink-0 items-center rounded-md border px-3.5 py-1.5 " +
        "text-sm font-medium " +
        cls
      }
    >
      {label}
    </span>
  );
}
