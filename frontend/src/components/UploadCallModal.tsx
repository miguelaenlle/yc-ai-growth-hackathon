import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { uploadCall } from "../lib/api";

// Hardcoded estimate for the progress bar — the real completion signal is the SSE
// "done" event, this just gives the bar something to animate against meanwhile.
const ESTIMATE_MS = 90_000;

const STEPS = ["Uploading", "Transcribing", "Analyzing", "Building tree", "Done"] as const;
// SSE processing.status → step index.
const STATUS_STEP: Record<string, number> = {
  transcribing: 1,
  analyzing: 2,
  routing: 3,
  done: 4,
};

type Phase = "form" | "working" | "error";

function UploadIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4M12 4L7 9M12 4l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function UploadCallModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (callId: string, company: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [company, setCompany] = useState("");
  const [buyer, setBuyer] = useState("");
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [stepIdx, setStepIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      esRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const canSubmit = !!file && company.trim().length > 0 && buyer.trim().length > 0;

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (!/\.mp3$|audio\/mpeg/i.test(f.name + " " + f.type)) {
      setError("Please choose an MP3 file.");
      return;
    }
    setError(null);
    setFile(f);
  };

  const finish = (callId: string) => {
    if (timerRef.current) clearInterval(timerRef.current);
    esRef.current?.close();
    setStepIdx(4);
    setProgress(100);
    // Brief beat so the user sees 100%, then hand off.
    setTimeout(() => onCreated(callId, company.trim()), 600);
  };

  const startProgressTimer = () => {
    const start = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - start;
      setProgress((p) => Math.max(p, Math.min(95, (elapsed / ESTIMATE_MS) * 95)));
    }, 500);
  };

  const submit = async () => {
    if (!canSubmit || !file) return;
    setPhase("working");
    setError(null);
    setStepIdx(0);
    setProgress(4);
    let ids;
    try {
      ids = await uploadCall(file, company.trim(), buyer.trim());
    } catch (e) {
      setPhase("error");
      const msg = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setError(msg ?? "Upload failed. Is the backend running on :3001?");
      return;
    }

    setStepIdx(1);
    startProgressTimer();

    const es = new EventSource(`/stream/${ids.recordingId}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      let event: { type?: string; status?: string; message?: string };
      try {
        event = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (event.type === "processing" && event.status) {
        const idx = STATUS_STEP[event.status];
        if (idx !== undefined) setStepIdx((s) => Math.max(s, idx));
        if (event.status === "done") {
          // The pipeline emits "done" on both success and failure; the success
          // message is "Call tree ready." Treat anything else as a soft error.
          if (event.message && /fail|error/i.test(event.message)) {
            if (timerRef.current) clearInterval(timerRef.current);
            es.close();
            setPhase("error");
            setError(event.message);
            return;
          }
          finish(ids!.callId);
        }
      }
    };
    es.onerror = () => {
      // SSE closes when the server ends the stream — not necessarily an error.
      // Completion is handled via the "done" event above.
    };
  };

  const overlay = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={phase === "working" ? undefined : onClose}
    >
      <div
        className="w-full max-w-md animate-fade-up rounded-xl border border-border-strong bg-surface p-6 shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Upload new call</h2>
          {phase !== "working" && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-text-faint transition-colors hover:text-text"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        {phase === "working" ? (
          <Progress stepIdx={stepIdx} progress={progress} />
        ) : (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0] ?? null);
              }}
              className={
                "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors " +
                (dragging ? "border-accent bg-accent/10" : "border-border-strong bg-surface-2 hover:border-accent/60")
              }
            >
              <span className="text-accent">
                <UploadIcon />
              </span>
              {file ? (
                <span className="text-sm font-medium text-text">{file.name}</span>
              ) : (
                <>
                  <span className="text-sm font-medium text-text">Drop an MP3 here</span>
                  <span className="text-xs text-text-faint">or click to browse</span>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/mpeg,.mp3"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </button>

            <div className="mt-4 space-y-3">
              <Field label="Company" value={company} onChange={setCompany} placeholder="Acme Corp" />
              <Field label="Buyer" value={buyer} onChange={setBuyer} placeholder="Alice Johnson" />
            </div>

            {error && <p className="mt-3 text-sm text-signal-low">{error}</p>}

            <button
              onClick={submit}
              disabled={!canSubmit}
              className="mt-5 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phase === "error" ? "Retry upload" : "Upload"}
            </button>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-20 shrink-0 text-text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-text outline-none transition-colors focus:border-accent"
      />
    </label>
  );
}

function Progress({ stepIdx, progress }: { stepIdx: number; progress: number }) {
  return (
    <div className="py-2">
      <p className="text-sm font-medium text-text">
        {STEPS[Math.min(stepIdx, STEPS.length - 1)]}
        {stepIdx < 4 && <span className="text-text-faint">…</span>}
      </p>
      <p className="mt-1 text-xs text-text-faint">Generating the call &amp; tree — about 1–2 min.</p>

      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <ol className="mt-4 space-y-1.5">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2 text-xs">
            <span
              className={
                "h-1.5 w-1.5 rounded-full " +
                (i < stepIdx ? "bg-accent" : i === stepIdx ? "animate-pulse bg-accent" : "bg-border-strong")
              }
            />
            <span className={i <= stepIdx ? "text-text-muted" : "text-text-faint"}>{label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
