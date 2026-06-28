import { NavLink } from "react-router-dom";

/** The two tabs on a call's page — the static CallTree review and the list of
    practice Recordings. Shared so both screens read identically. */
export function CallTabs({ id, state }: { id: string; state?: unknown }) {
  const cls = (active: boolean) =>
    "-mb-px border-b-2 pb-2 transition-colors " +
    (active
      ? "border-accent font-medium text-text"
      : "border-transparent text-text-faint hover:text-text-muted");

  return (
    <div className="flex items-center gap-5 border-b border-border text-sm">
      <NavLink to={`/call/${id}`} end state={state} className={({ isActive }) => cls(isActive)}>
        CallTree
      </NavLink>
      <NavLink to={`/call/${id}/recordings`} state={state} className={({ isActive }) => cls(isActive)}>
        Recordings
      </NavLink>
    </div>
  );
}
