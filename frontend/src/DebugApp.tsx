import { useState, useEffect, useRef, useCallback } from "react";

const BASE = "http://localhost:3001";

// ─── Types ──────────────────────────────────────────────────────────────────

type ApiLog = {
  id: number;
  ts: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
};

type SseLog = {
  id: number;
  ts: string;
  type: string;
  data: unknown;
};

// ─── Hardcoded Tableau demo payloads ────────────────────────────────────────

const DEMO_SEGMENTS = [
  {
    index: 0,
    speaker: "buyer",
    text: "You don't have Tableau integration. Our analytics team is fully standardized on it.",
    tStartMs: 0,
    tEndMs: 7000,
  },
  {
    index: 1,
    speaker: "seller",
    text: "Totally understand — your team won't need to change anything. Our SQL connectors pipe data directly into Tableau.",
    tStartMs: 8000,
    tEndMs: 17000,
  },
  {
    index: 2,
    speaker: "buyer",
    text: "Oh, so we'd keep Tableau and just pipe data in through your connectors? That actually works for us. Let's book a demo.",
    tStartMs: 18000,
    tEndMs: 28000,
  },
];

const DEMO_NOTES_WINDOW = DEMO_SEGMENTS;

// ─── Helpers ─────────────────────────────────────────────────────────────────

let logIdCounter = 0;
const nextId = () => ++logIdCounter;

async function callApi(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function now() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function statusColor(s: number) {
  if (s >= 200 && s < 300) return "text-green-400";
  if (s >= 400) return "text-red-400";
  return "text-yellow-400";
}

const SSE_COLORS: Record<string, string> = {
  transcript: "text-blue-300",
  move: "text-purple-300",
  metrics: "text-yellow-300",
  branch: "text-orange-300",
  notes: "text-green-300",
};

// ─── Diff helpers ─────────────────────────────────────────────────────────

function flatKeys(obj: unknown, prefix = ""): Set<string> {
  const keys = new Set<string>();
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const full = prefix ? `${prefix}.${k}` : k;
      keys.add(full);
      for (const sub of flatKeys(v, full)) keys.add(sub);
    }
  }
  return keys;
}

function changedKeys(prev: unknown, next: unknown): Set<string> {
  const changed = new Set<string>();
  const prevStr = JSON.stringify(prev ?? {});
  const nextStr = JSON.stringify(next ?? {});
  if (prevStr === nextStr) return changed;

  const prevKeys = flatKeys(prev);
  const nextKeys = flatKeys(next);
  for (const k of nextKeys) {
    if (!prevKeys.has(k)) changed.add(k);
  }
  // Simple top-level value diff
  if (prev && next && typeof prev === "object" && typeof next === "object") {
    for (const k of Object.keys(next as object)) {
      if (JSON.stringify((prev as Record<string, unknown>)[k]) !== JSON.stringify((next as Record<string, unknown>)[k])) {
        changed.add(k);
      }
    }
  }
  return changed;
}

// ─── Components ──────────────────────────────────────────────────────────────

function JsonView({ data, changed }: { data: unknown; changed?: Set<string> }) {
  const lines = JSON.stringify(data, null, 2).split("\n");
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-all">
      {lines.map((line, i) => {
        const isChanged =
          changed &&
          changed.size > 0 &&
          [...changed].some((k) => line.includes(`"${k.split(".").pop()}":`));
        return (
          <span key={i} className={isChanged ? "bg-yellow-900/60 block" : "block"}>
            {line}
          </span>
        );
      })}
    </pre>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function DebugApp() {
  const [apiLogs, setApiLogs] = useState<ApiLog[]>([]);
  const [sseLogs, setSseLogs] = useState<SseLog[]>([]);
  const [lastResp, setLastResp] = useState<ApiLog | null>(null);
  const [store, setStore] = useState<unknown>(null);
  const [prevStore, setPrevStore] = useState<unknown>(null);
  const [storeChanged, setStoreChanged] = useState<Set<string>>(new Set());
  const [rightTab, setRightTab] = useState<"store" | "sse">("store");
  const [sseConnected, setSseConnected] = useState(false);
  const [activeRecId, setActiveRecId] = useState<string>("rec_real");
  const [scenarioRunning, setScenarioRunning] = useState(false);
  const [scenarioLog, setScenarioLog] = useState<string[]>([]);
  const sseRef = useRef<EventSource | null>(null);
  const apiLogEndRef = useRef<HTMLDivElement>(null);
  const sseLogEndRef = useRef<HTMLDivElement>(null);

  // ── Store polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    async function poll() {
      try {
        const { data } = await callApi("GET", "/debug/store");
        setStore((prev) => {
          const changed = changedKeys(prev, data);
          setStoreChanged(changed);
          setPrevStore(prev);
          return data;
        });
      } catch {
        // backend not up yet — ignore
      }
    }
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, []);

  // ── Auto-scroll logs ──────────────────────────────────────────────────────
  useEffect(() => {
    apiLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [apiLogs]);
  useEffect(() => {
    sseLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sseLogs]);

  // ── API call helper ───────────────────────────────────────────────────────
  const fire = useCallback(
    async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const { status, data } = await callApi(method, path, body);
      const entry: ApiLog = { id: nextId(), ts: now(), method, path, status, body: data };
      setApiLogs((prev) => [...prev.slice(-199), entry]);
      setLastResp(entry);
      return data;
    },
    []
  );

  // ── SSE ───────────────────────────────────────────────────────────────────
  function connectSse(recId: string) {
    if (sseRef.current) sseRef.current.close();
    const es = new EventSource(`${BASE}/stream/${recId}`);
    sseRef.current = es;
    setSseConnected(true);
    setRightTab("sse");
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data);
        setSseLogs((prev) => [
          ...prev.slice(-299),
          { id: nextId(), ts: now(), type: parsed.type ?? "unknown", data: parsed },
        ]);
      } catch {
        setSseLogs((prev) => [
          ...prev.slice(-299),
          { id: nextId(), ts: now(), type: "raw", data: e.data },
        ]);
      }
    };
    es.onerror = () => setSseConnected(false);
  }

  function disconnectSse() {
    sseRef.current?.close();
    sseRef.current = null;
    setSseConnected(false);
  }

  // ── Scenario runner ───────────────────────────────────────────────────────
  async function runTableauScenario() {
    setScenarioRunning(true);
    setScenarioLog([]);
    const log = (msg: string) => setScenarioLog((prev) => [...prev, msg]);

    try {
      log("1/6 → POST /recordings (startNodeId: n_push)…");
      const recResp = await fire("POST", "/recordings", {
        callId: "call_convex",
        isReal: false,
        startNodeId: "n_push",
      }) as { recordingId?: string };
      const newRecId = recResp?.recordingId ?? "rec_real";
      setActiveRecId(newRecId);
      log(`    ✓ created recording: ${newRecId}`);

      connectSse(newRecId);
      await delay(600);

      log("2/6 → PATCH /recordings/:id (Tableau demo segments)…");
      await fire("PATCH", `/recordings/${newRecId}`, { segments: DEMO_SEGMENTS });
      log("    ✓ segments appended + tree traversal updated");
      await delay(600);

      log("3/6 → POST /agent/notes…");
      await fire("POST", "/agent/notes", {
        recordingId: newRecId,
        window: DEMO_NOTES_WINDOW,
      });
      log("    ✓ notes extracted");
      await delay(600);

      log("4/6 → POST /agent/branch (SQL connectors utterance)…");
      await fire("POST", "/agent/branch", {
        recordingId: newRecId,
        currentNodeId: "n_push",
        utterance: "What if we use SQL connectors to pipe data into Tableau instead?",
      });
      log("    ✓ branch decision made");
      await delay(600);

      log("5/6 → POST /recordings/:id/feedback…");
      await fire("POST", `/recordings/${newRecId}/feedback`);
      log("    ✓ feedback generated");
      await delay(600);

      log("6/6 → GET /recordings/:id/walkthrough?kind=review…");
      await fire("GET", `/recordings/${newRecId}/walkthrough?kind=review`);
      log("    ✓ walkthrough bundle returned");

      log("── Scenario complete ──");
    } catch (err) {
      log(`ERROR: ${String(err)}`);
    } finally {
      setScenarioRunning(false);
    }
  }

  function delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col font-mono text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-white font-bold tracking-wide">CallTree Debug Panel</span>
          <span className="text-gray-500 text-xs">branch: debug/frontend-testrig</span>
        </div>
        <button
          onClick={runTableauScenario}
          disabled={scenarioRunning}
          className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold"
        >
          {scenarioRunning ? "Running…" : "▶ Run Tableau Scenario"}
        </button>
      </div>

      {/* Scenario log strip */}
      {scenarioLog.length > 0 && (
        <div className="px-4 py-2 bg-gray-900 border-b border-gray-800 text-xs text-gray-300 space-y-0.5 max-h-28 overflow-y-auto">
          {scenarioLog.map((l, i) => (
            <div key={i} className={l.startsWith("ERROR") ? "text-red-400" : l.startsWith("──") ? "text-emerald-400 font-bold" : ""}>{l}</div>
          ))}
        </div>
      )}

      {/* Three-column body */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: API Controls ── */}
        <div className="w-56 shrink-0 bg-gray-900 border-r border-gray-700 overflow-y-auto p-2 space-y-1">
          <Section label="Phase 1 — Read">
            <Btn label="GET /calls" onClick={() => fire("GET", "/calls")} />
            <Btn label="GET /calls/call_convex" onClick={() => fire("GET", "/calls/call_convex")} />
            <Btn label="GET /trees/tree_convex" onClick={() => fire("GET", "/trees/tree_convex")} />
            <Btn label="GET /recordings/rec_real" onClick={() => fire("GET", "/recordings/rec_real")} />
            <Btn label="GET /recordings/rec_mock1" onClick={() => fire("GET", "/recordings/rec_mock1")} />
          </Section>

          <Section label="Phase 2 — Lifecycle">
            <Btn
              label="POST /recordings"
              onClick={async () => {
                const d = await fire("POST", "/recordings", {
                  callId: "call_convex",
                  isReal: false,
                  startNodeId: "n_push",
                }) as { recordingId?: string };
                if (d?.recordingId) setActiveRecId(d.recordingId);
              }}
            />
            <Btn
              label={`PATCH /recordings/:id`}
              sublabel={activeRecId}
              onClick={() =>
                fire("PATCH", `/recordings/${activeRecId}`, { segments: DEMO_SEGMENTS })
              }
            />
            <Btn
              label="POST /feedback"
              sublabel={activeRecId}
              onClick={() => fire("POST", `/recordings/${activeRecId}/feedback`)}
            />
          </Section>

          <Section label="Phase 3–4 — Agents">
            <Btn
              label="POST /mock/turn"
              onClick={() =>
                fire("POST", "/mock/turn", {
                  recordingId: activeRecId,
                  role: "both",
                  currentNodeId: "n_push",
                })
              }
            />
            <Btn
              label="POST /agent/notes"
              onClick={() =>
                fire("POST", "/agent/notes", {
                  recordingId: activeRecId,
                  window: DEMO_NOTES_WINDOW,
                })
              }
            />
            <Btn
              label="POST /agent/branch"
              onClick={() =>
                fire("POST", "/agent/branch", {
                  recordingId: activeRecId,
                  currentNodeId: "n_push",
                  utterance: "What if we use SQL connectors instead?",
                })
              }
            />
            <Btn
              label="POST /transcribe"
              onClick={() => fire("POST", "/transcribe", { recordingId: activeRecId, tStartMs: 0 })}
            />
          </Section>

          <Section label="Phase 5 — AI/TTS stubs">
            <Btn
              label="GET /walkthrough review"
              sublabel={activeRecId}
              onClick={() =>
                fire("GET", `/recordings/${activeRecId}/walkthrough?kind=review`)
              }
            />
            <Btn
              label="GET /walkthrough intro"
              sublabel={activeRecId}
              onClick={() =>
                fire("GET", `/recordings/${activeRecId}/walkthrough?kind=intro`)
              }
            />
            <Btn
              label="POST /tts"
              onClick={() =>
                fire("POST", "/tts", {
                  text: "Let me walk you through this call.",
                  voiceId: "rachel",
                })
              }
            />
          </Section>

          <Section label="SSE Stream">
            <div className="text-xs text-gray-400 mb-1">
              Rec: <span className="text-gray-200">{activeRecId}</span>
            </div>
            {!sseConnected ? (
              <Btn label="Connect SSE" onClick={() => connectSse(activeRecId)} />
            ) : (
              <Btn label="Disconnect SSE" variant="danger" onClick={disconnectSse} />
            )}
            <div className={`text-xs mt-1 ${sseConnected ? "text-green-400" : "text-gray-500"}`}>
              {sseConnected ? "● connected" : "○ disconnected"}
            </div>
          </Section>

          <Section label="Active Recording">
            <input
              className="w-full bg-gray-800 text-gray-100 text-xs px-2 py-1 rounded border border-gray-600 focus:outline-none focus:border-blue-500"
              value={activeRecId}
              onChange={(e) => setActiveRecId(e.target.value)}
              placeholder="recording id"
            />
            <div className="text-xs text-gray-500 mt-1">
              Editable — set after POST /recordings
            </div>
          </Section>
        </div>

        {/* ── Center: Last Response + API Log ── */}
        <div className="flex flex-col flex-1 min-w-0 border-r border-gray-700">
          {/* Last response */}
          <div className="shrink-0 border-b border-gray-700 bg-gray-900 p-3">
            {lastResp ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs text-gray-400">{lastResp.ts}</span>
                  <span className="text-xs font-bold text-gray-200">{lastResp.method}</span>
                  <span className="text-xs text-gray-300">{lastResp.path}</span>
                  <span className={`text-xs font-bold ${statusColor(lastResp.status)}`}>
                    {lastResp.status}
                  </span>
                </div>
                <div className="overflow-auto max-h-64 bg-gray-950 rounded p-2 text-gray-200">
                  <JsonView data={lastResp.body} />
                </div>
              </>
            ) : (
              <div className="text-gray-500 text-xs">No request made yet — click a button on the left.</div>
            )}
          </div>

          {/* API call history */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <div className="text-xs text-gray-500 mb-1">Request history</div>
            {apiLogs.length === 0 && (
              <div className="text-xs text-gray-600">—</div>
            )}
            {apiLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-center gap-2 text-xs cursor-pointer hover:bg-gray-800 rounded px-1 py-0.5"
                onClick={() => setLastResp(log)}
              >
                <span className="text-gray-500 w-16 shrink-0">{log.ts}</span>
                <span className="text-gray-400 w-10 shrink-0">{log.method}</span>
                <span className="text-gray-300 flex-1 truncate">{log.path}</span>
                <span className={`shrink-0 font-bold ${statusColor(log.status)}`}>{log.status}</span>
              </div>
            ))}
            <div ref={apiLogEndRef} />
          </div>
        </div>

        {/* ── Right: Store / SSE ── */}
        <div className="w-96 shrink-0 flex flex-col bg-gray-900">
          {/* Tabs */}
          <div className="flex border-b border-gray-700 shrink-0">
            <TabBtn active={rightTab === "store"} onClick={() => setRightTab("store")}>
              Store Snapshot
            </TabBtn>
            <TabBtn active={rightTab === "sse"} onClick={() => setRightTab("sse")}>
              SSE Events {sseLogs.length > 0 && <span className="ml-1 text-gray-400">({sseLogs.length})</span>}
            </TabBtn>
          </div>

          {rightTab === "store" && (
            <div className="flex-1 overflow-y-auto p-2 text-gray-200">
              {storeChanged.size > 0 && (
                <div className="mb-2 text-xs text-yellow-400">
                  {storeChanged.size} key(s) changed since last poll
                </div>
              )}
              {store ? (
                <JsonView data={store} changed={storeChanged} />
              ) : (
                <div className="text-xs text-gray-500">
                  Waiting for backend… (polls every 2 s)
                </div>
              )}
            </div>
          )}

          {rightTab === "sse" && (
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {!sseConnected && sseLogs.length === 0 && (
                <div className="text-xs text-gray-500">
                  Connect SSE in the left panel to stream live events.
                </div>
              )}
              {sseLogs.map((log) => (
                <div key={log.id} className="text-xs border-b border-gray-800 pb-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-gray-500">{log.ts}</span>
                    <span className={`font-bold ${SSE_COLORS[log.type] ?? "text-gray-300"}`}>
                      {log.type}
                    </span>
                  </div>
                  <div className="text-gray-400 ml-2">
                    <JsonView data={log.data} />
                  </div>
                </div>
              ))}
              <div ref={sseLogEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Small sub-components ─────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-gray-500 text-xs uppercase tracking-wider px-1 pt-2 pb-1">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Btn({
  label,
  sublabel,
  onClick,
  variant = "default",
}: {
  label: string;
  sublabel?: string;
  onClick: () => void;
  variant?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1 rounded text-xs hover:opacity-90 active:opacity-70 ${
        variant === "danger"
          ? "bg-red-900 hover:bg-red-800 text-red-200"
          : "bg-gray-800 hover:bg-gray-700 text-gray-200"
      }`}
    >
      <div className="truncate">{label}</div>
      {sublabel && <div className="text-gray-500 text-xs truncate">{sublabel}</div>}
    </button>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
        active
          ? "border-blue-500 text-blue-400"
          : "border-transparent text-gray-500 hover:text-gray-300"
      }`}
    >
      {children}
    </button>
  );
}
