import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Panel,
  useReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { BASE_W, BASE_H, type CallNodeData, type RawNode } from "./treeData";
import { applyFocus } from "./focus";
import { CallNode } from "./CallNode";
import { NodePreview } from "./NodePreview";
import { TreeMiniMap } from "./TreeMiniMap";

const nodeTypes = { call: CallNode };

const DURATION = 440;
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface CallTreeProps {
  /** The tree structure (drives focus layout/hop distances). */
  root: RawNode;
  /** React Flow nodes/edges derived from `root` (via buildView). */
  nodes: Node<CallNodeData>[];
  edges: Edge[];
  /** Node to focus on mount. */
  rootId: string;
  /** Drives focus externally in real time (e.g. a live session moving nodes). */
  focusId?: string;
  /** Fired on every node click, after focus moves to it. */
  onNodeClick?: (nodeId: string, data: CallNodeData) => void;
  /** Optional content rendered in the top-right panel. */
  topRight?: ReactNode;
}

function Flow({ root, nodes: baseNodes, edges: baseEdges, rootId, focusId, onNodeClick, topRight }: CallTreeProps) {
  // Click a node to focus it; everything else shrinks with distance from it.
  const [selectedId, setSelectedId] = useState(rootId);
  const [nodes, setNodes] = useState(
    () => applyFocus(root, baseNodes, baseEdges, rootId).nodes,
  );
  const [edges, setEdges] = useState(
    () => applyFocus(root, baseNodes, baseEdges, rootId).edges,
  );
  const { setCenter, getZoom, getViewport } = useReactFlow();
  const first = useRef(true);
  const raf = useRef<number | undefined>(undefined);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Re-run the focus layout whenever the graph itself changes (new nodes grafted
  // on by a live session), not just on selection.
  const graphKey = baseNodes.map((n) => n.id).join(",");

  // External focus: follow the session's active node in real time.
  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  // Hover preview for shrunk (title-only) nodes: a screen-space card anchored to
  // the node so it stays readable regardless of zoom.
  const [preview, setPreview] = useState<{
    data: CallNodeData;
    x: number;
    yTop: number;
    yBottom: number;
  } | null>(null);

  const onNodeEnter = (_: unknown, n: Node) => {
    const data = n.data as CallNodeData;
    if (!data.titleOnly) {
      setPreview(null);
      return;
    }
    const vp = getViewport();
    const w = n.width ?? BASE_W;
    const h = n.height ?? BASE_H;
    setPreview({
      data,
      x: (n.position.x + w / 2) * vp.zoom + vp.x,
      yTop: n.position.y * vp.zoom + vp.y,
      yBottom: (n.position.y + h) * vp.zoom + vp.y,
    });
  };

  // On selection change, tween every node's position/size from where it is now
  // to the repacked target. Driving it through state (not CSS) means the edges
  // re-route every frame and animate together with the nodes.
  useEffect(() => {
    // Guard: a focus target may briefly not exist in the current graph.
    const safeId = baseNodes.some((n) => n.id === selectedId) ? selectedId : rootId;
    const { nodes: target, edges: targetEdges } = applyFocus(
      root,
      baseNodes,
      baseEdges,
      safeId,
    );
    setEdges(targetEdges);
    if (first.current) {
      first.current = false;
      setNodes(target);
      return;
    }
    const fromById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const start = performance.now();
    cancelAnimationFrame(raf.current!);

    const tick = (now: number) => {
      const t = easeInOut(Math.min(1, (now - start) / DURATION));
      setNodes(
        target.map((tn) => {
          const fn = fromById.get(tn.id) ?? tn;
          const tw = (tn.width ?? BASE_W), th = (tn.height ?? BASE_H);
          const fw = (fn.width ?? BASE_W), fh = (fn.height ?? BASE_H);
          const ts = (tn.data as { scale?: number }).scale ?? 1;
          const fs = (fn.data as { scale?: number }).scale ?? 1;
          return {
            ...tn,
            width: lerp(fw, tw, t),
            height: lerp(fh, th, t),
            position: {
              x: lerp(fn.position.x, tn.position.x, t),
              y: lerp(fn.position.y, tn.position.y, t),
            },
            data: { ...tn.data, scale: lerp(fs, ts, t) },
          };
        }),
      );
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    const f = target.find((n) => (n.data as { focused?: boolean }).focused);
    if (f) {
      setCenter(
        f.position.x + (f.width ?? BASE_W) / 2,
        f.position.y + (f.height ?? BASE_H) / 2,
        { zoom: Math.max(getZoom(), 0.85), duration: DURATION },
      );
    }
    return () => cancelAnimationFrame(raf.current!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, graphKey]);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n: Node) => {
          setSelectedId(n.id);
          onNodeClick?.(n.id, n.data as CallNodeData);
        }}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseLeave={() => setPreview(null)}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.5}
          color="var(--color-border)"
        />
        <Panel position="bottom-right">
          <TreeMiniMap nodes={nodes} edges={edges} />
        </Panel>
        {topRight && (
          <Panel position="top-right" className="flex items-center gap-3">
            {topRight}
          </Panel>
        )}
      </ReactFlow>
      {preview && (
        <div
          className="pointer-events-none absolute z-50"
          style={
            preview.yTop > 180
              ? {
                  left: preview.x,
                  top: preview.yTop - 12,
                  transform: "translate(-50%, -100%)",
                }
              : {
                  left: preview.x,
                  top: preview.yBottom + 12,
                  transform: "translate(-50%, 0)",
                }
          }
        >
          <NodePreview data={preview.data} />
        </div>
      )}
    </>
  );
}

export function CallTree(props: CallTreeProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
