import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CallNodeData } from "./treeData";

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

  return (
    <div
      style={{ animationDelay: `${depth * 70}ms`, width: 240 }}
      className={
        "group rounded-lg border bg-surface px-4 py-3 " +
        "shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-colors duration-150 " +
        (isAi
          ? "ct-glimmer border-accent/40 hover:border-accent/70"
          : d.onPath
            ? "animate-fade-up border-accent/60"
            : "animate-fade-up border-border hover:border-border-strong")
      }
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />

      {/* tag row */}
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
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span className="text-text-muted">Real</span>
          </>
        )}
      </div>

      <div className="truncate text-[15px] font-semibold text-text">{d.title}</div>
      {d.description && (
        <div className="mt-0.5 text-[13px] leading-snug text-text-muted">
          {d.description}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

export const CallNode = memo(CallNodeImpl);
