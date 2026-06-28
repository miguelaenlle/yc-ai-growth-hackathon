import { useMutation } from "@tanstack/react-query";
import { fetchMockAnalysis } from "../lib/api";

/**
 * POST /recordings/:id/mock-analysis — fired once when a HUMAN practice call
 * ends, to drive the post-call analysis popup. A mutation (not a query) because
 * it has a side effect: it updates the rep's stats on the server.
 */
export function useMockAnalysis() {
  return useMutation({
    mutationFn: ({
      recordingId,
      personaId,
    }: {
      recordingId: string;
      personaId: string;
    }) => fetchMockAnalysis(recordingId, personaId),
  });
}
