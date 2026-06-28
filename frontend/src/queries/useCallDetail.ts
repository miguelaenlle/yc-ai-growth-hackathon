import { useQuery } from "@tanstack/react-query";
import { fetchCallDetail } from "../lib/api";

export function useCallDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["call", id],
    queryFn: () => fetchCallDetail(id!),
    enabled: !!id,
  });
}
