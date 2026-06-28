/** Default tree focus node when the review page loads or after summarize ends.
 *  The canonical tree root (unified backend/UI id). */
export const SUMMARIZE_START_NODE_ID = "n_open";

/** Node/camera tween when the user clicks a node manually (idle review). */
export const SUMMARIZE_IDLE_FOCUS_MS = 440;

/** Node/camera tween while the summarize walkthrough is playing. Kept short so
 *  each focus change snaps into place well within a node's ~3–4s narration. */
export const SUMMARIZE_NODE_DURATION_MS = 320;

/** fitView duration when zooming back out after summarize finishes. */
export const SUMMARIZE_OVERVIEW_FIT_MS = 650;

/** Extra wait after the repack tween before fitView (ms). */
export const SUMMARIZE_OVERVIEW_DELAY_MS = 80;
