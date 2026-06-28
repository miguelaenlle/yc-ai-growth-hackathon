import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { BASE_W, BASE_H, type CallNodeData } from "./treeData";

function rampColor(p: number): string {
  if (p >= 0.7) return "var(--color-signal-high)";
  if (p >= 0.4) return "var(--color-signal-mid)";
  return "var(--color-signal-low)";
}

function Sparkle() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M12 3L13.6 8.4L19 10L13.6 11.6L12 17L10.4 11.6L5 10L10.4 8.4L12 3Z"
        fill="currentColor"
      />
      <path d="M18.5 14.5L19.2 16.8L21.5 17.5L19.2 18.2L18.5 20.5L17.8 18.2L15.5 17.5L17.8 16.8L18.5 14.5Z" fill="currentColor" />
    </svg>
  );
}

const handleStyle = { opacity: 0, width: 1, height: 1, border: "none", background: "transparent" };

function CallNodeImpl({ data }: NodeProps) {
  const d = data as CallNodeData;
  const isAi = d.kind === "ai";
  const depth = typeof d.depth === "number" ? d.depth : 0;
  const scale = typeof d.scale === "number" ? d.scale : 1;
  const titleOnly = d.titleOnly === true;

  return (
    // Outer wrapper fills the (focus-scaled) React Flow box; handles anchor here
    // so edges stay correct. The card inside is fixed-size and scaled.
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <Handle type="target" position={Position.Left} style={handleStyle} />

      {/* Scale lives on this wrapper (no animation), so the card's fade-up /
          glimmer animation can't clobber the transform. */}
      <div
        style={{
          width: BASE_W,
          height: BASE_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
      <div
        style={{
          animationDelay: `${depth * 70}ms`,
          width: "100%",
          height: "100%",
          opacity: typeof d.opacity === "number" ? d.opacity : 1,
        }}
        className={
          "group flex cursor-pointer flex-col rounded-lg transition-[opacity,border-color,box-shadow] duration-300 " +
          (titleOnly ? "items-center justify-center px-3 py-2 text-center " : "px-4 py-3 ") +
          (d.focused
            ? "ring-2 ring-accent "
            : d.onCurrentPath
              ? "ring-1 ring-accent/50 "
              : "") +
          (isAi
            ? "ct-glimmer border border-accent/60 bg-surface shadow-[0_0_16px_-6px_rgba(61,214,208,0.45)] hover:border-accent/90"
            : "animate-fade-up border-l-[3px] border-y border-r border-y-border-strong border-r-border-strong border-l-text-muted bg-surface-2 shadow-[0_1px_2px_rgba(0,0,0,0.4)] hover:border-l-text")
        }
      >
      {/* tag row */}
      {!titleOnly && (
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        {isAi ? (
          <>
            <span className="text-accent">
              <Sparkle />
            </span>
            <span className="text-accent">AI</span>
            {typeof d.success === "number" && (
              <span style={{ color: rampColor(d.success) }}>
                · {Math.round(d.success * 100)}% success
              </span>
            )}
          </>
        ) : (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full bg-text-muted" />
            <span className="uppercase tracking-wide text-text-muted">Real</span>
          </>
        )}
      </div>
      )}

      <div
        className={
          "font-semibold text-text " +
          (titleOnly
            ? "text-[26px] leading-tight break-words"
            : "truncate text-[15px]")
        }
      >
        {d.title}
      </div>
      {!titleOnly && d.description && (
        <div className="mt-0.5 text-[13px] leading-snug text-text-muted">
          {d.description}
        </div>
      )}
      </div>
      </div>

      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

export const CallNode = memo(CallNodeImpl);
