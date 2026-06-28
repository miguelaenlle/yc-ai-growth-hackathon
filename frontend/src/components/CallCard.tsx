import { useNavigate } from "react-router-dom";
import type { CallSummary } from "../lib/types";
import { formatDateTime } from "../lib/format";
import { participantsFor, type Person } from "../lib/placeholders";
import { OutcomeBadge } from "./OutcomeBadge";

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.5V12L15 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BuyerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
      <path d="M4 20C4 16.6863 7.58172 14 12 14C16.4183 14 20 16.6863 20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SellerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M4 13V11C4 6.58172 7.58172 3 12 3C16.4183 3 20 6.58172 20 11V13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect x="3" y="13" width="3.5" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="17.5" y="13" width="3.5" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <path d="M19 19V20C19 21.1046 18.1046 22 17 22H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PersonRow({ icon, person }: { icon: React.ReactNode; person: Person }) {
  return (
    <span className="flex items-center gap-2 text-[15px] text-text-muted">
      <span className="text-text-faint">{icon}</span>
      <span className="text-text">{person.name}</span>
      <span className="truncate text-text-faint">- {person.title}</span>
    </span>
  );
}

export function CallCard({ call, index }: { call: CallSummary; index: number }) {
  const navigate = useNavigate();
  const { buyer, salesperson } = participantsFor(call.company);

  return (
    <button
      onClick={() => navigate(`/call/${call.id}`)}
      style={{ animationDelay: `${index * 60}ms` }}
      className={
        "group w-full animate-fade-up rounded-lg border border-border bg-surface " +
        "px-5 py-4 text-left outline-none transition-all duration-150 " +
        "hover:-translate-y-px hover:border-border-strong hover:bg-surface-2 " +
        "hover:shadow-[0_1px_2px_rgba(0,0,0,0.4)] " +
        "focus-visible:ring-1 focus-visible:ring-accent"
      }
    >
      <div className="flex items-start justify-between gap-4">
        {/* left column — company + participants, stacked, left-aligned */}
        <div className="min-w-0 space-y-2">
          <h3 className="truncate text-lg font-semibold text-text">
            {call.company}
          </h3>
          <PersonRow icon={<BuyerIcon />} person={buyer} />
          <PersonRow icon={<SellerIcon />} person={salesperson} />
        </div>

        {/* right column — date on top, outcome below, right-aligned */}
        <div className="flex shrink-0 flex-col items-end gap-3">
          <span className="flex items-center gap-2 text-[15px] text-text-muted">
            <ClockIcon />
            {formatDateTime(call.startedAt)}
          </span>
          <OutcomeBadge outcome={call.outcome} />
        </div>
      </div>
    </button>
  );
}
