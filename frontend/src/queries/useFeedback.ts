import { useQuery } from "@tanstack/react-query";
import { fetchFeedback } from "../lib/api";

/**
 * POST /recordings/:id/feedback — the post-call review for a recording, including
 * System 2's `recommendedStart`. Modeled as a query: the backend is idempotent
 * (it returns/augments the cached feedback), so refetching is safe.
 */
export function useFeedback(recordingId: string | undefined) {
  return useQuery({
    queryKey: ["feedback", recordingId],
    queryFn: () => fetchFeedback(recordingId!),
    enabled: !!recordingId,
    staleTime: Infinity,
  });
}
