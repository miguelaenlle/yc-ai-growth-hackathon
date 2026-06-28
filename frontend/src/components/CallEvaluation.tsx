import { formatEvK } from "../lib/format";

// A per-call evaluation replacing the binary Won/Lost badge: the realized EV
// (where the rep actually landed) plus a graded word on the green→red ramp.
// The grade is the realized EV as a share of the best achievable EV in the tree.

type Tier = "high" | "mid" | "low";

const TIER_CLS: Record<Tier, string> = {
  high: "text-signal-high border-signal-high/30 bg-signal-high/10",
  mid: "text-signal-mid border-signal-mid/30 bg-signal-mid/10",
  low: "text-signal-low border-signal-low/30 bg-signal-low/10",
};

function grade(ratio: number): { label: string; tier: Tier } {
  if (ratio >= 0.85) return { label: "Strong", tier: "high" };
  if (ratio >= 0.6) return { label: "Promising", tier: "high" };
  if (ratio >= 0.35) return { label: "Mixed", tier: "mid" };
  if (ratio >= 0.12) return { label: "Stalled", tier: "mid" };
  return { label: "Cold", tier: "low" };
}

export function CallEvaluation({
  finalEV,
  bestEV,
}: {
  finalEV: number;
  bestEV: number;
}) {
  const ratio = bestEV > 0 ? finalEV / bestEV : 0;
  const { label, tier } = grade(ratio);
  return (
    <span
      title={`Realized expected value of this call. Best achievable here: ${formatEvK(bestEV)}.`}
      className={
        "inline-flex shrink-0 items-center gap-2 rounded-md border px-3.5 py-1.5 " +
        "text-sm font-medium " +
        TIER_CLS[tier]
      }
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-current" />
      <span className="tabular-nums">{formatEvK(finalEV)}</span>
      <span className="opacity-60">·</span>
      <span>{label}</span>
    </span>
  );
}
