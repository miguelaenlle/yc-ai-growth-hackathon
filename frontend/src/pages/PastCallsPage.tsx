import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCalls } from "../queries/useCalls";
import { toDateKey } from "../lib/format";
import { Logo } from "../components/Logo";
import { Button } from "../components/Button";
import { FilterBar } from "../components/FilterBar";
import type { DateRange } from "../components/DateRangePicker";
import { CallCard } from "../components/CallCard";
import { PerfectPracticeCard } from "../components/PerfectPracticeCard";

const EMPTY_RANGE: DateRange = { start: null, end: null };

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 5V19M5 12H19"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// The rep whose pipeline this account belongs to. The list defaults to them;
// the others stay selectable so the data still reads like a team.
const FEATURED_REP_ID = "sp_jane";

export function PastCallsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useCalls();

  const [company, setCompany] = useState("");
  const [range, setRange] = useState<DateRange>(EMPTY_RANGE);
  const [repId, setRepId] = useState<string>(FEATURED_REP_ID);

  const calls = data ?? [];

  const reps = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of calls) if (c.salesperson?.id) map.set(c.salesperson.id, c.salesperson.name);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [calls]);

  const companies = useMemo(
    () => Array.from(new Set(calls.map((c) => c.company))).sort(),
    [calls],
  );

  const shown = useMemo(
    () =>
      calls.filter((c) => {
        if (repId !== "all" && c.salesperson?.id !== repId) return false;
        if (company && c.company !== company) return false;
        const key = toDateKey(c.startedAt);
        if (range.start && key < range.start) return false;
        if (range.end && key > range.end) return false;
        return true;
      }),
    [calls, repId, company, range],
  );

  const activeCount = (company ? 1 : 0) + (range.start || range.end ? 1 : 0);
  const clearFilters = () => {
    setCompany("");
    setRange(EMPTY_RANGE);
  };

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-4xl px-6 py-10">
        {/* logo on its own line — with the tenant org chip */}
        <div className="mb-6 animate-fade-up">
          <Logo org="Slack" />
        </div>

        {/* title + count on the left, actions on the right — one line */}
        <header className="relative z-30 mb-6 flex animate-fade-up flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-text">
              Past Calls
            </h1>
            <span className="font-mono text-base text-text-muted">
              {shown.length}/{calls.length} shown
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {reps.length > 1 && (
              <select
                value={repId}
                onChange={(e) => setRepId(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text outline-none transition-colors hover:border-border-strong focus:border-accent"
                aria-label="Filter by rep"
              >
                {reps.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                <option value="all">All reps</option>
              </select>
            )}
            <FilterBar
              companies={companies}
              company={company}
              onCompany={setCompany}
              range={range}
              onRange={setRange}
              activeCount={activeCount}
              onClear={clearFilters}
            />
            <Button onClick={() => navigate("/new")}>
              <PlusIcon />
              Take new call
            </Button>
            <button
              onClick={() => navigate("/admin")}
              title="Admin · refresh insights"
              aria-label="Admin"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:border-border-strong hover:text-text"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="2" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 004 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H8a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V8a1.65 1.65 0 001.51 1H22a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </header>

        {/* System 1 — the perfect practice call for a selectable rep */}
        <PerfectPracticeCard />

        {/* list */}
        <div className="space-y-3">
          {isLoading && <Skeletons />}

          {isError && (
            <StateCard>
              Couldn&apos;t load calls. Is the backend running on{" "}
              <span className="font-mono text-text-muted">:3001</span>?
            </StateCard>
          )}

          {!isLoading && !isError && shown.length === 0 && (
            <StateCard>
              {calls.length === 0
                ? "No calls yet."
                : "No calls match these filters."}
            </StateCard>
          )}

          {shown.map((call, i) => (
            <CallCard key={call.id} call={call} index={i} />
          ))}
        </div>
      </div>
    </main>
  );
}

function Skeletons() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{ animationDelay: `${i * 60}ms` }}
          className="h-[58px] animate-fade-up rounded-lg border border-border bg-surface"
        >
          <div className="flex h-full items-center px-5">
            <div className="h-3 w-32 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </>
  );
}

function StateCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="animate-fade-up rounded-lg border border-border bg-surface px-5 py-8 text-center text-sm text-text-muted">
      {children}
    </div>
  );
}
