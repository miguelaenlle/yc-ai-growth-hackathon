import type { Id } from "./types";

/** Backend seed node ids → frontend treeData ids (recorded spine). */
export const BACKEND_TO_UI_NODE: Record<Id, string> = {
  n_open: "opening",
  n_disc: "discovery",
  n_push: "pushback",
  n_road: "roadmap",
  n_lost: "deal_lost",
  n_alt: "alternative",
  n_agree: "continue",
};

export function toUiNodeId(backendNodeId: Id): string {
  return BACKEND_TO_UI_NODE[backendNodeId] ?? backendNodeId;
}
