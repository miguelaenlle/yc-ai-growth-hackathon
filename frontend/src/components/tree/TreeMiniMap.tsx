import { useStore, type Node, type Edge } from "@xyflow/react";
import { BASE_W, BASE_H, type CallNodeData } from "./treeData";

const BOX_W = 230;
const BOX_H = 150;
const PAD = 12;

/** A small overview that mirrors the live (focus-scaled) tree: mini cards styled
    like the real nodes (AI grid+glimmer, neutral Real, seller left bar), edges
    between them, and a subtle rectangle showing the current view. */
export function TreeMiniMap({
  nodes,
  edges,
}: {
  nodes: Node<CallNodeData>[];
  edges: Edge[];
}) {
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const vw = useStore((s) => s.width);
  const vh = useStore((s) => s.height);

  if (!nodes.length) return null;

  // bounds of the live tree
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = n.width ?? BASE_W;
    const h = n.height ?? BASE_H;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const k = Math.min((BOX_W - 2 * PAD) / contentW, (BOX_H - 2 * PAD) / contentH);
  const offX = PAD + ((BOX_W - 2 * PAD) - contentW * k) / 2;
  const offY = PAD + ((BOX_H - 2 * PAD) - contentH * k) / 2;
  const px = (x: number) => (x - minX) * k + offX;
  const py = (y: number) => (y - minY) * k + offY;

  // node centers for edges
  const center = new Map<string, [number, number]>();
  for (const n of nodes) {
    const w = n.width ?? BASE_W;
    const h = n.height ?? BASE_H;
    center.set(n.id, [px(n.position.x + w / 2), py(n.position.y + h / 2)]);
  }

  // current view rectangle (visible flow area → mini coords)
  const vx0 = px(-tx / zoom);
  const vy0 = py(-ty / zoom);
  const vx1 = px((vw - tx) / zoom);
  const vy1 = py((vh - ty) / zoom);

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-border bg-surface shadow-[0_4px_16px_rgba(0,0,0,0.5)]"
      style={{ width: BOX_W, height: BOX_H }}
    >
      <svg width={BOX_W} height={BOX_H} className="pointer-events-none absolute inset-0">
        {edges.map((e) => {
          const a = center.get(e.source);
          const b = center.get(e.target);
          if (!a || !b) return null;
          const onPath = (e.style?.stroke as string) === "var(--color-accent)";
          return (
            <line
              key={e.id}
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              stroke={onPath ? "var(--color-accent)" : "var(--color-text-faint)"}
              strokeWidth={onPath ? 1.2 : 0.6}
              strokeOpacity={onPath ? 0.85 : 0.16}
            />
          );
        })}
      </svg>

      {nodes.map((n) => {
        // floor the size so far/shrunk nodes stay visible
        const w = Math.max((n.width ?? BASE_W) * k, 9);
        const h = Math.max((n.height ?? BASE_H) * k, 6);
        const isAi = n.data.kind === "ai";
        const seller = n.data.actor === "seller";
        const focused = n.data.focused === true;
        return (
          <div
            key={n.id}
            className={
              "absolute rounded-[3px] border " +
              (focused
                ? "border-accent bg-accent/70 "
                : isAi
                  ? "border-accent/70 bg-accent/25 "
                  : "border-text-faint/50 bg-border-strong ") +
              (seller ? "border-l-[2px] border-l-seller" : "")
            }
            style={{ left: px(n.position.x), top: py(n.position.y), width: w, height: h }}
          />
        );
      })}

      {/* subtle current-view rectangle */}
      <div
        className="pointer-events-none absolute rounded-sm border border-border-strong bg-text/[0.04]"
        style={{ left: vx0, top: vy0, width: vx1 - vx0, height: vy1 - vy0 }}
      />
    </div>
  );
}
