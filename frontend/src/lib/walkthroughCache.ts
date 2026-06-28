import { fetchWalkthrough } from "./api";
import type { WalkthroughBundle } from "./types";

const bundleCache = new Map<string, WalkthroughBundle>();
const inflight = new Map<string, Promise<WalkthroughBundle>>();

const CACHE_VERSION = "v2";

function cacheKey(recordingId: string, kind: "intro" | "review"): string {
  return `${CACHE_VERSION}:${recordingId}:${kind}`;
}

/** Session cache — one fetch per recording/kind; replays reuse the in-memory bundle. */
export async function getWalkthrough(
  recordingId: string,
  kind: "intro" | "review" = "review"
): Promise<WalkthroughBundle> {
  const key = cacheKey(recordingId, kind);
  const hit = bundleCache.get(key);
  if (hit) return hit;

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchWalkthrough(recordingId, kind).then((bundle) => {
      bundleCache.set(key, bundle);
      inflight.delete(key);
      return bundle;
    });
    inflight.set(key, pending);
  }
  return pending;
}

export function peekWalkthrough(
  recordingId: string,
  kind: "intro" | "review" = "review"
): WalkthroughBundle | undefined {
  return bundleCache.get(cacheKey(recordingId, kind));
}
