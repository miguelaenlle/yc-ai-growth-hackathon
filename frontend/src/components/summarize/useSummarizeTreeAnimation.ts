import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import { applyFocus } from "../tree/focus";
import {
  TREE,
  initialNodes,
  initialEdges,
  BASE_W,
  BASE_H,
  type CallNodeData,
} from "../tree/treeData";
import {
  SUMMARIZE_IDLE_FOCUS_MS,
  SUMMARIZE_NODE_DURATION_MS,
  SUMMARIZE_OVERVIEW_DELAY_MS,
  SUMMARIZE_OVERVIEW_FIT_MS,
  SUMMARIZE_START_NODE_ID,
} from "./summarize_constants";
import { summarize_easeInOut, summarize_lerp } from "./summarize_easing";

interface UseSummarizeTreeAnimationOptions {
  nodes: Node<CallNodeData>[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  setNodes: Dispatch<SetStateAction<Node<CallNodeData>[]>>;
  setEdges: Dispatch<SetStateAction<ReturnType<typeof applyFocus>["edges"]>>;
  isSummarizePlaying: boolean;
  /** Base nodes/edges to repack — defaults to the static review tree. Pass an
   *  augmented copy (e.g. with per-node `onSimulate`) to keep that data across
   *  the animation, since every frame is rebuilt from these. */
  baseNodes?: Node<CallNodeData>[];
  baseEdges?: ReturnType<typeof applyFocus>["edges"];
}

/**
 * Repacks and tweens the review tree on focus changes.
 * Uses slower timing during summarize playback vs idle manual clicks.
 */
export function useSummarizeTreeAnimation({
  nodes,
  selectedId,
  setSelectedId,
  setNodes,
  setEdges,
  isSummarizePlaying,
  baseNodes = initialNodes,
  baseEdges = initialEdges,
}: UseSummarizeTreeAnimationOptions) {
  const { setCenter, getZoom, fitView } = useReactFlow();
  const first = useRef(true);
  const raf = useRef<number | undefined>(undefined);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const skipCenterRef = useRef(false);
  const forceIdleMotionRef = useRef(false);
  const overviewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isSummarizePlayingRef = useRef(isSummarizePlaying);
  isSummarizePlayingRef.current = isSummarizePlaying;

  const summarize_scheduleOverviewFit = useCallback(() => {
    clearTimeout(overviewTimerRef.current);
    const repackMs = SUMMARIZE_IDLE_FOCUS_MS;
    overviewTimerRef.current = setTimeout(() => {
      void fitView({
        padding: 0.2,
        duration: SUMMARIZE_OVERVIEW_FIT_MS,
        minZoom: 0.2,
      });
    }, repackMs + SUMMARIZE_OVERVIEW_DELAY_MS);
  }, [fitView]);

  const summarize_resetToStart = useCallback(() => {
    forceIdleMotionRef.current = true;
    skipCenterRef.current = true;
    setSelectedId(SUMMARIZE_START_NODE_ID);
    summarize_scheduleOverviewFit();
  }, [setSelectedId, summarize_scheduleOverviewFit]);

  useEffect(() => {
    const { nodes: target, edges: targetEdges } = applyFocus(
      TREE,
      baseNodes,
      baseEdges,
      selectedId,
    );
    setEdges(targetEdges);

    const duration =
      forceIdleMotionRef.current || !isSummarizePlayingRef.current
        ? SUMMARIZE_IDLE_FOCUS_MS
        : SUMMARIZE_NODE_DURATION_MS;
    if (forceIdleMotionRef.current) forceIdleMotionRef.current = false;

    if (first.current) {
      first.current = false;
      setNodes(target);
      return;
    }

    const fromById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const start = performance.now();
    cancelAnimationFrame(raf.current!);

    const tick = (now: number) => {
      const t = summarize_easeInOut(Math.min(1, (now - start) / duration));
      setNodes(
        target.map((tn) => {
          const fn = fromById.get(tn.id) ?? tn;
          const tw = tn.width ?? BASE_W;
          const th = tn.height ?? BASE_H;
          const fw = fn.width ?? BASE_W;
          const fh = fn.height ?? BASE_H;
          const ts = (tn.data as { scale?: number }).scale ?? 1;
          const fs = (fn.data as { scale?: number }).scale ?? 1;
          return {
            ...tn,
            width: summarize_lerp(fw, tw, t),
            height: summarize_lerp(fh, th, t),
            position: {
              x: summarize_lerp(fn.position.x, tn.position.x, t),
              y: summarize_lerp(fn.position.y, tn.position.y, t),
            },
            data: { ...tn.data, scale: summarize_lerp(fs, ts, t) },
          };
        }),
      );
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    const f = target.find((n) => (n.data as { focused?: boolean }).focused);
    const skippingCenter = skipCenterRef.current;
    if (skippingCenter) {
      skipCenterRef.current = false;
    } else if (f) {
      setCenter(
        f.position.x + (f.width ?? BASE_W) / 2,
        f.position.y + (f.height ?? BASE_H) / 2,
        {
          zoom: Math.max(getZoom(), 0.85),
          duration,
        },
      );
    }

    return () => cancelAnimationFrame(raf.current!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    return () => clearTimeout(overviewTimerRef.current);
  }, []);

  return { summarize_resetToStart };
}
