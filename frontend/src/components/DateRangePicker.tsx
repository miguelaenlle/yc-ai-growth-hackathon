import { useEffect, useState } from "react";

export interface DateRange {
  start: string | null; // YYYY-MM-DD
  end: string | null;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** YYYY-MM-DD → editable "M/D/YYYY" for the text inputs. */
function keyToInput(key: string | null): string {
  if (!key) return "";
  const [y, m, d] = key.split("-").map(Number);
  return `${m}/${d}/${y}`;
}

/** Parse typed dates tolerantly: "6/22/2026", "06/22/26", or "2026-06-22".
    Returns a YYYY-MM-DD key, or null if unparseable. */
function parseDateInput(s: string): string | null {
  const t = s.trim();
  let y: number, mo: number, d: number;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
  } else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    [mo, d, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
  } else {
    return null;
  }
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null; // rejects things like 13/40/2026
  }
  return ymd(dt);
}

function NavIcon({ dir }: { dir: "prev" | "next" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={dir === "prev" ? "M15 6L9 12L15 18" : "M9 6L15 12L9 18"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const inputCls =
  "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-text " +
  "outline-none transition-colors duration-150 placeholder:text-text-faint " +
  "focus-visible:border-border-strong focus-visible:ring-1 focus-visible:ring-accent";

/** Date range you can type into or pick from the calendar. The two stay in sync:
    typing a valid date moves the calendar; clicking the calendar fills the inputs. */
export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
}) {
  const anchor = value.start ? new Date(`${value.start}T00:00:00`) : new Date();
  const [view, setView] = useState(
    new Date(anchor.getFullYear(), anchor.getMonth(), 1),
  );

  // Local buffers so typing is uncommitted until blur/Enter; resync when the
  // range changes from elsewhere (calendar clicks, clear filters).
  const [startText, setStartText] = useState(keyToInput(value.start));
  const [endText, setEndText] = useState(keyToInput(value.end));
  useEffect(() => setStartText(keyToInput(value.start)), [value.start]);
  useEffect(() => setEndText(keyToInput(value.end)), [value.end]);

  const y = view.getFullYear();
  const m = view.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));

  function pick(day: Date) {
    const key = ymd(day);
    if (!value.start || value.end) {
      onChange({ start: key, end: null });
    } else if (key >= value.start) {
      onChange({ start: value.start, end: key });
    } else {
      onChange({ start: key, end: null });
    }
  }

  function commitStart() {
    const t = startText.trim();
    if (!t) return onChange({ start: null, end: value.end });
    const key = parseDateInput(t);
    if (!key) return setStartText(keyToInput(value.start)); // revert
    const end = value.end && key > value.end ? null : value.end;
    onChange({ start: key, end });
    setView(new Date(`${key}T00:00:00`));
  }

  function commitEnd() {
    const t = endText.trim();
    if (!t) return onChange({ start: value.start, end: null });
    const key = parseDateInput(t);
    // reject unparseable or an end before the start
    if (!key || (value.start && key < value.start)) {
      return setEndText(keyToInput(value.end));
    }
    onChange({ start: value.start, end: key });
    setView(new Date(`${key}T00:00:00`));
  }

  const shift = (delta: number) => setView(new Date(y, m + delta, 1));

  return (
    <div className="w-[244px]">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <input
          value={startText}
          onChange={(e) => setStartText(e.target.value)}
          onBlur={commitStart}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder="Start"
          aria-label="Start date"
          className={inputCls}
        />
        <input
          value={endText}
          onChange={(e) => setEndText(e.target.value)}
          onBlur={commitEnd}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder="End"
          aria-label="End date"
          className={inputCls}
        />
      </div>

      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => shift(-1)}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          aria-label="Previous month"
        >
          <NavIcon dir="prev" />
        </button>
        <span className="text-sm font-medium text-text">
          {MONTHS[m]} {y}
        </span>
        <button
          type="button"
          onClick={() => shift(1)}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          aria-label="Next month"
        >
          <NavIcon dir="next" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-y-1">
        {WEEKDAYS.map((w, i) => (
          <span
            key={i}
            className="py-1 text-center text-[10px] font-medium text-text-faint"
          >
            {w}
          </span>
        ))}

        {cells.map((day, i) => {
          if (!day) return <span key={i} />;
          const key = ymd(day);
          const isEdge = key === value.start || key === value.end;
          const inRange =
            value.start && value.end && key > value.start && key < value.end;

          return (
            <button
              key={i}
              type="button"
              onClick={() => pick(day)}
              className={
                "mx-auto flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors " +
                (isEdge
                  ? "bg-accent font-medium text-bg"
                  : inRange
                    ? "bg-accent-quiet text-text"
                    : "text-text-muted hover:bg-surface-2 hover:text-text")
              }
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
