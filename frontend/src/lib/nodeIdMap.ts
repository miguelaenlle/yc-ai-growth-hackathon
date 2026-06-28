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

/** Frontend treeData ids → backend seed node ids (inverse of the map above). */
export const UI_TO_BACKEND_NODE: Record<string, Id> = Object.fromEntries(
  Object.entries(BACKEND_TO_UI_NODE).map(([backendId, uiId]) => [uiId, backendId]),
);

/** True when a UI tree node maps to a real backend node (i.e. is simulatable). */
export function isSimulatableUiNode(uiNodeId: string): boolean {
  return uiNodeId in UI_TO_BACKEND_NODE;
}

export function toBackendNodeId(uiNodeId: string): Id {
  return UI_TO_BACKEND_NODE[uiNodeId] ?? uiNodeId;
}
