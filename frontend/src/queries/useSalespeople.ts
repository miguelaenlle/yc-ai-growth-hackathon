import { useQuery } from "@tanstack/react-query";
import { fetchSalespeople } from "../lib/api";

/** GET /salespeople — the reps for the practice picker (System 1). */
export function useSalespeople() {
  return useQuery({
    queryKey: ["salespeople"],
    queryFn: fetchSalespeople,
    staleTime: Infinity, // baselines are static for the session
  });
}
