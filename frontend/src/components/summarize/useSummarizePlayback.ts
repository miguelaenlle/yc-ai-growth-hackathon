import { useEffect, useRef } from "react";
import type { WalkthroughBundle } from "../../lib/types";
import { summarize_activeCueIndex } from "./summarize_timeline";

interface UseSummarizePlaybackOptions {
  walkthrough: WalkthroughBundle | null;
  isPlaying: boolean;
  onNodeFocus: (uiNodeId: string) => void;
  onEnded: () => void;
}

/**
 * Drives summarize playback and syncs tree focus to the audio.
 *
 * Exact path (per-node `segments`): each node has its own TTS clip. We preload
 * them and play them sequentially — focus the node the instant its clip starts,
 * and advance on the clip's `ended` event. The node boundary IS the clip
 * boundary, so sync is exact by construction — no character-count or bitrate
 * estimation, and (unlike a Web Audio clock) nothing to desync if the browser
 * defers audio start. Clips are preloaded so the hand-off between them is tight.
 *
 * Fallback (no segments): the old single-file `<audio>` + timeline-cue path.
 */
export function useSummarizePlayback({
  walkthrough,
  isPlaying,
  onNodeFocus,
  onEnded,
}: UseSummarizePlaybackOptions) {
  const onNodeFocusRef = useRef(onNodeFocus);
  onNodeFocusRef.current = onNodeFocus;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const walkthroughRef = useRef(walkthrough);
  walkthroughRef.current = walkthrough;

  useEffect(() => {
    if (!isPlaying) return;
    const wt = walkthroughRef.current;
    if (!wt) return;

    let cancelled = false;

    // ---- Exact path: per-node clips played sequentially ----
    if (wt.segments && wt.segments.length > 0) {
      const segments = wt.segments;
      // Preload every clip up front so each hand-off is near-instant.
      const clips = segments.map((s) => {
        const a = new Audio(s.audioUrl);
        a.preload = "auto";
        return a;
      });

      let i = -1;
      const playNext = () => {
        if (cancelled) return;
        i += 1;
        if (i >= segments.length) {
          onEndedRef.current();
          return;
        }
        onNodeFocusRef.current(segments[i].nodeId);
        const a = clips[i];
        a.onended = playNext;
        a.onerror = playNext; // skip a broken clip rather than stall the run
        void a.play().catch(() => playNext());
      };
      playNext();

      return () => {
        cancelled = true;
        for (const a of clips) {
          a.onended = null;
          a.onerror = null;
          a.pause();
        }
      };
    }

    // ---- Fallback: single concatenated file + estimated timeline cues ----
    const audio = new Audio(wt.audioUrl);
    const onTime = () => {
      const i = summarize_activeCueIndex(wt.timeline, audio.currentTime * 1000);
      onNodeFocusRef.current(wt.timeline[i].nodeId);
    };
    const onEnd = () => onEndedRef.current();
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    void audio.play().catch((err) => {
      console.error("Summarize playback failed:", err);
      onEndedRef.current();
    });

    return () => {
      cancelled = true;
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnd);
      audio.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);
}
