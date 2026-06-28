import { useQuery } from "@tanstack/react-query";
import { fetchCalls } from "../lib/api";

export function useCalls() {
  return useQuery({
    queryKey: ["calls"],
    queryFn: fetchCalls,
  });
}
