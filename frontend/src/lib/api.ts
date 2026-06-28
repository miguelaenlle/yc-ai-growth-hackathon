import axios from "axios";
import type {
  CallDetail,
  CallSummary,
  MockCallAnalysis,
  PersonaInfo,
  WalkthroughBundle,
} from "./types";

// Relative baseURL — Vite proxies /calls, /trees, etc. to :3001 in dev
export const api = axios.create({ baseURL: "" });
/** GET /calls → CallSummary[], newest first (backend sorts by startedAt desc). */
export async function fetchCalls(): Promise<CallSummary[]> {
  const { data } = await api.get<CallSummary[]>("/calls");
  return data;
}

/** GET /calls/:id → CallDetail ({ call, tree, recordings }). */
export async function fetchCallDetail(callId: string): Promise<CallDetail> {
  const { data } = await api.get<CallDetail>(`/calls/${callId}`);
  return data;
}

/** GET /personas → PersonaInfo[] (buyer personas for the practice picker). */
export async function fetchPersonas(): Promise<PersonaInfo[]> {
  const { data } = await api.get<PersonaInfo[]>("/personas");
  return data;
}

/** POST /recordings/:id/mock-analysis → MockCallAnalysis (post-call popup). */
export async function fetchMockAnalysis(
  recordingId: string,
  personaId: string
): Promise<MockCallAnalysis> {
  const { data } = await api.post<MockCallAnalysis>(
    `/recordings/${recordingId}/mock-analysis`,
    { personaId }
  );
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
