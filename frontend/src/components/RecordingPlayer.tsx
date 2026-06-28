import { useEffect, useMemo, useRef, useState } from "react";
import type { Recording } from "../lib/types";

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
    </svg>
  );
}

/** Compact transport for a recording: scrubbable progress, play/pause, and a
    live two-line transcript caption synced to the playhead. Drives the UI from a
    timer (the seed audio files may not exist locally) while best-effort piping
    the real <audio> in sync, so the demo always scrubs. */
export function RecordingPlayer({
  recording,
  buyerName,
}: {
  recording: Recording;
  buyerName: string;
}) {
  const total = recording.lengthMs;
  const [ms, setMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Reset the playhead whenever the selected recording changes.
  useEffect(() => {
    setMs(0);
    setPlaying(false);
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
  }, [recording.id]);

  useEffect(() => {
    if (!playing) return;
    const start = performance.now() - ms;
    let raf = 0;
    const tick = (now: number) => {
      const next = now - start;
      if (next >= total) {
        setMs(total);
        setPlaying(false);
        return;
      }
      setMs(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, total]);

  const toggle = () => {
    const a = audioRef.current;
    if (playing) {
      a?.pause();
      setPlaying(false);
      return;
    }
    if (ms >= total) setMs(0);
    if (a) {
      a.currentTime = (ms >= total ? 0 : ms) / 1000;
      void a.play().catch(() => {}); // no local audio file is fine
    }
    setPlaying(true);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const next = frac * total;
    setMs(next);
    if (audioRef.current) audioRef.current.currentTime = next / 1000;
  };

  // The two most recent segments that have started — reads like a live caption.
  const caption = useMemo(() => {
    const started = recording.transcript.filter((s) => s.tStartMs <= ms);
    return started.slice(-2);
  }, [recording.transcript, ms]);

  const pct = total > 0 ? (ms / total) * 100 : 0;

  return (
    <div className="space-y-4">
      <audio ref={audioRef} src={recording.audioPath} preload="none" className="hidden" />

      <div className="flex items-center gap-4">
        <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted">
          {mmss(ms)}/{mmss(total)}
        </span>
        <div
          onClick={seek}
          className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-surface-2"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: `${pct}%` }}
          />
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-opacity group-hover:opacity-100"
            style={{ left: `${pct}%` }}
          />
        </div>
        <button
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-bg shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-all duration-150 hover:brightness-110 active:scale-95"
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
      </div>

      <div className="min-h-[3.25rem] space-y-1 text-[15px] italic leading-snug text-text-muted">
        {caption.map((s) => (
          <p key={s.index}>
            <span className="font-medium not-italic text-text">
              {s.speaker === "seller" ? "You" : buyerName}:
            </span>{" "}
            {s.text}
          </p>
        ))}
      </div>
    </div>
  );
}
