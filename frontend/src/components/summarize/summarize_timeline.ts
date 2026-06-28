import type { WalkthroughBundle } from "../../lib/types";

/** Index of the timeline cue active at `timeMs` during summarize playback. */
export function summarize_activeCueIndex(
  timeline: WalkthroughBundle["timeline"],
  timeMs: number
): number {
  let idx = 0;
  for (let i = 0; i < timeline.length; i++) {
    if (timeMs >= timeline[i].atMs) idx = i;
    else break;
  }
  return idx;
}
