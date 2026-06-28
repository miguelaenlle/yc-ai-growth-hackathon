import { useQuery } from "@tanstack/react-query";
import { fetchRecommendedPractice } from "../lib/api";

/**
 * GET /salespeople/:id/recommended-practice — the "perfect practice call" for one
 * rep (System 1). Deterministic on the backend, so it's safe to cache per rep.
 */
export function useRecommendedPractice(salespersonId: string | undefined) {
  return useQuery({
    queryKey: ["recommended-practice", salespersonId],
    queryFn: () => fetchRecommendedPractice(salespersonId!),
    enabled: !!salespersonId,
    staleTime: Infinity,
  });
}
