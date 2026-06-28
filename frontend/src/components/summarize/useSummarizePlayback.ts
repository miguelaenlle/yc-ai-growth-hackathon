import { useCallback, useEffect, useRef } from "react";
import type { WalkthroughBundle } from "../../lib/types";
import { summarize_activeCueIndex } from "./summarize_timeline";

interface UseSummarizePlaybackOptions {
  walkthrough: WalkthroughBundle | null;
  isPlaying: boolean;
  onNodeFocus: (uiNodeId: string) => void;
  onEnded: () => void;
}

/**
 * Drives summarize audio playback and syncs tree focus to timeline cues.
 * Separate from precap / mock-session WebSocket playback in _legacy/.
 */
export function useSummarizePlayback({
  walkthrough,
  isPlaying,
  onNodeFocus,
  onEnded,
}: UseSummarizePlaybackOptions) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const walkthroughRef = useRef(walkthrough);
  walkthroughRef.current = walkthrough;

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    const wt = walkthroughRef.current;
    if (!audio || !wt) return;
    const idx = summarize_activeCueIndex(wt.timeline, audio.currentTime * 1000);
    // Backend and UI node ids are unified (see tree.generated.ts), so cue ids
    // address tree nodes directly — no mapping needed.
    onNodeFocus(wt.timeline[idx].nodeId);
  }, [onNodeFocus]);

  const handleEnded = useCallback(() => {
    onEnded();
  }, [onEnded]);

  useEffect(() => {
    if (!isPlaying || !walkthrough) return;

    const audio = new Audio(walkthrough.audioUrl);
    audioRef.current = audio;
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);

    void audio.play().catch((err) => {
      console.error("Summarize playback failed:", err);
      onEnded();
    });

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
      audioRef.current = null;
    };
  }, [isPlaying, walkthrough, handleTimeUpdate, handleEnded, onEnded]);
}
