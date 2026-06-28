import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminStatus, refreshInsights } from "../lib/api";

/** GET /admin/status — when the LLM insights were last regenerated. */
export function useAdminStatus() {
  return useQuery({ queryKey: ["admin-status"], queryFn: fetchAdminStatus });
}

/** POST /admin/refresh — regenerate insights, then invalidate dependent queries. */
export function useRefreshInsights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshInsights,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-status"] });
      qc.invalidateQueries({ queryKey: ["recommended-practice"] });
      qc.invalidateQueries({ queryKey: ["feedback"] });
    },
  });
}
