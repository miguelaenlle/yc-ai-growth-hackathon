import axios from "axios";
import type { CallDetail, CallSummary, WalkthroughBundle } from "./types";

// Relative baseURL — Vite proxies /calls, /trees, etc. to :3001 in dev
export const api = axios.create({ baseURL: "" });
/** GET /calls → CallSummary[], newest first (backend sorts by startedAt desc). */
export async function fetchCalls(): Promise<CallSummary[]> {
  const { data } = await api.get<CallSummary[]>("/calls");
  return data;
}

/** GET /calls/:id → CallDetail */
export async function fetchCallDetail(callId: string): Promise<CallDetail> {
  const { data } = await api.get<CallDetail>(`/calls/${callId}`);
  return data;
}

/** GET /recordings/:id/walkthrough?kind=intro|review → WalkthroughBundle */
export async function fetchWalkthrough(
  recordingId: string,
  kind: "intro" | "review" = "review"
): Promise<WalkthroughBundle> {
  const { data } = await api.get<WalkthroughBundle>(
    `/recordings/${recordingId}/walkthrough`,
    { params: { kind } }
  );
  return data;
}
