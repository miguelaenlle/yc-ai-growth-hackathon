import { useEffect, useRef, useState } from "react";
import { DateRangePicker, type DateRange } from "./DateRangePicker";
import { shortDate } from "../lib/format";

const selectCls =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm " +
  "outline-none transition-colors duration-150 " +
  "focus-visible:border-border-strong focus-visible:ring-1 focus-visible:ring-accent " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

function FunnelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 5H21L14 13V19L10 21V13L3 5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

export interface FilterBarProps {
  companies: string[];
  company: string;
  onCompany: (v: string) => void;
  range: DateRange;
  onRange: (r: DateRange) => void;
  activeCount: number;
  onClear: () => void;
}

export function FilterBar({
  companies,
  company,
  onCompany,
  range,
  onRange,
  activeCount,
  onClear,
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const rangeLabel =
    range.start && range.end
      ? `${shortDate(range.start)} – ${shortDate(range.end)}`
      : range.start
        ? `From ${shortDate(range.start)}`
        : "Any date";

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={
          "inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-sm transition-all duration-150 " +
          "outline-none focus-visible:ring-1 focus-visible:ring-accent " +
          (activeCount > 0 || open
            ? "border-border-strong bg-surface-2 text-text"
            : "border-border bg-surface text-text-muted hover:border-border-strong hover:text-text")
        }
      >
        <FunnelIcon />
        Filters
        {activeCount > 0 && (
          <span className="ml-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-medium text-bg">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 z-20 mt-2 w-72 origin-top-right animate-fade-up rounded-lg border border-border bg-surface p-4 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          style={{ animationDuration: "0.15s" }}
        >
          <div className="space-y-4">
            <Field label="Company">
              <select
                value={company}
                onChange={(e) => onCompany(e.target.value)}
                className={`${selectCls} ${company ? "text-text" : "text-text-muted"}`}
              >
                <option value="">All companies</option>
                {companies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            {/* Person filter needs participant data the list endpoint doesn't
                expose — present for parity, disabled until /calls carries it. */}
            <Field label="Person">
              <select
                disabled
                className={`${selectCls} text-text-muted`}
                title="Coming soon — needs participant data on /calls"
              >
                <option>Anyone</option>
              </select>
            </Field>

            <Field label={`Date range · ${rangeLabel}`}>
              <DateRangePicker value={range} onChange={onRange} />
            </Field>
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
            <button
              type="button"
              onClick={onClear}
              disabled={activeCount === 0}
              className="text-xs text-text-muted transition-colors hover:text-text disabled:opacity-40 disabled:hover:text-text-muted"
            >
              Clear filters
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent-quiet"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
