import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCalls } from "../queries/useCalls";
import { toDateKey } from "../lib/format";
import { Logo } from "../components/Logo";
import { Button } from "../components/Button";
import { FilterBar } from "../components/FilterBar";
import type { DateRange } from "../components/DateRangePicker";
import { CallCard } from "../components/CallCard";

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

export function PastCallsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useCalls();

  const [company, setCompany] = useState("");
  const [range, setRange] = useState<DateRange>(EMPTY_RANGE);

  const calls = data ?? [];

  const companies = useMemo(
    () => Array.from(new Set(calls.map((c) => c.company))).sort(),
    [calls],
  );

  const shown = useMemo(
    () =>
      calls.filter((c) => {
        if (company && c.company !== company) return false;
        const key = toDateKey(c.startedAt);
        if (range.start && key < range.start) return false;
        if (range.end && key > range.end) return false;
        return true;
      }),
    [calls, company, range],
  );

  const activeCount = (company ? 1 : 0) + (range.start || range.end ? 1 : 0);
  const clearFilters = () => {
    setCompany("");
    setRange(EMPTY_RANGE);
  };

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-4xl px-6 py-10">
        {/* logo on its own line */}
        <div className="mb-6 animate-fade-up">
          <Logo />
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
          </div>
        </header>

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
