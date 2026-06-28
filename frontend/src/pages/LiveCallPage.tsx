import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CallTree } from "../components/tree/CallTree";
import { Logo } from "../components/Logo";
import { TREE, initialNodes, initialEdges } from "../components/tree/treeData";
import { participantsFor } from "../lib/placeholders";

// The live call builds on the one seeded company (Slack). The tree is the
// static review tree, focused on the moment the call is currently at.
const COMPANY = "Slack";
const CURRENT_NODE = "n_incumbent";

// Curated live intel for the demo — kept to exactly what the figma shows.
const NOTES = ["Currently on Microsoft Teams", "250 seats", "Plans to purchase in Q4 2026"];
const RECOMMENDATION = { text: "Reframe: run Slack alongside Teams", confidence: "76% chance of success" };

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function startedLabel(d: Date): string {
  const date = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-[15px] leading-snug text-text-muted">
          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-text-faint" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

export function LiveCallPage() {
  const navigate = useNavigate();
  const { buyer, salesperson } = participantsFor(COMPANY);

  // Wall-clock start of the live call; the timer counts up from here.
  const [startedAt] = useState(() => new Date());
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-screen bg-bg text-text">
      {/* Sidebar — call identity, participants, timer, and the lost control */}
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
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-text">Live Call</h1>
            <div className="mt-1.5 flex items-center gap-2 text-sm font-medium text-signal-low">
              <span className="h-2 w-2 animate-pulse rounded-full bg-signal-low" />
              Recording
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="font-medium text-text">{buyer.name}</div>
            <div className="text-sm text-text-muted">{buyer.title}</div>
          </div>
          <div>
            <div className="font-medium text-text">{salesperson.name}</div>
            <div className="text-sm text-text-muted">{salesperson.title}</div>
          </div>
        </div>

        <div className="space-y-1 font-mono text-[13px] leading-relaxed text-text-muted">
          <div>{startedLabel(startedAt)}</div>
          <div className="text-base tabular-nums text-text">{mmss(seconds)}</div>
        </div>

        <button
          onClick={() => navigate("/")}
          className="mt-auto self-start rounded-md border border-signal-low/40 bg-signal-low/10 px-6 py-2.5 text-sm font-medium text-signal-low transition-colors hover:bg-signal-low/20"
        >
          Lost
        </button>
      </aside>

      {/* Live intel — notes + recommendations */}
      <section className="flex w-[280px] shrink-0 flex-col gap-8 overflow-y-auto border-r border-border px-7 py-8">
        <div className="space-y-2.5">
          <h2 className="text-base font-semibold text-text">Notes</h2>
          <Bullets items={NOTES} />
        </div>

        <div className="space-y-2.5">
          <h2 className="text-base font-semibold text-text">Recommendations</h2>
          <ul className="space-y-1.5">
            <li className="flex gap-2 text-[15px] leading-snug text-text-muted">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-text-faint" />
              <span>
                {RECOMMENDATION.text}
                <span className="mt-0.5 block italic text-text-faint">{RECOMMENDATION.confidence}</span>
              </span>
            </li>
          </ul>
        </div>
      </section>

      {/* Live tree */}
      <div className="relative min-w-0 flex-1">
        <CallTree
          root={TREE}
          nodes={initialNodes}
          edges={initialEdges}
          rootId="n_open"
          focusId={CURRENT_NODE}
        />
      </div>
    </div>
  );
}
