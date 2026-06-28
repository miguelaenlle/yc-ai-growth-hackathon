import { useQuery } from "@tanstack/react-query";
import { fetchPersonas } from "../lib/api";

/** GET /personas — the buyer personas the AI can play (for the picker). */
export function usePersonas() {
  return useQuery({
    queryKey: ["personas"],
    queryFn: fetchPersonas,
    staleTime: Infinity, // static for the session
  });
}
