/** ISO 8601 → "Thu, 6/25/2026 5:00 PM" (en-US). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const date = d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${weekday}, ${date} ${time}`;
}

/** Currency → compact label: 42750 → "$42.8k", 3600 → "$3.6k", 800 → "$800". */
export function formatEvK(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

/** Date key (YYYY-MM-DD) → short label like "Jun 25". */
export function shortDate(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Local YYYY-MM-DD for an ISO timestamp — used to match a date range. */
export function toDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
