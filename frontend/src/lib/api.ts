import axios from "axios";
import type { CallSummary } from "./types";

// Relative baseURL — Vite proxies /calls, /trees, etc. to :3001 in dev
// (see vite.config.ts).
export const api = axios.create({ baseURL: "" });

/** GET /calls → CallSummary[], newest first (backend sorts by startedAt desc). */
export async function fetchCalls(): Promise<CallSummary[]> {
  const { data } = await api.get<CallSummary[]>("/calls");
  return data;
}
