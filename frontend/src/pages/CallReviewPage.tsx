import { useNavigate } from "react-router-dom";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { initialNodes, initialEdges } from "../components/tree/treeData";
import { CallNode } from "../components/tree/CallNode";
import { OutcomeBadge } from "../components/OutcomeBadge";
import { Logo } from "../components/Logo";

const nodeTypes = { call: CallNode };

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Sidebar() {
  const navigate = useNavigate();
  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-6 border-r border-border bg-bg px-6 py-6">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 self-start text-sm text-accent transition-opacity hover:opacity-80"
      >
        <BackArrow />
        Back
      </button>

      <div className="space-y-3">
        <Logo />
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Convex <span className="font-mono text-base text-text-muted">6/25/2026</span>
        </h1>
      </div>

      {/* tabs (visual only) */}
      <div className="flex items-center gap-5 border-b border-border text-sm">
        <span className="-mb-px border-b-2 border-accent pb-2 font-medium text-text">
          CallTree
        </span>
        <span className="-mb-px border-b-2 border-transparent pb-2 text-text-faint">
          Runs
        </span>
      </div>

      <div className="space-y-4">
        <div>
          <div className="font-medium text-text">John Doe</div>
          <div className="text-sm text-text-muted">VP of Operations</div>
        </div>
        <div>
          <div className="font-medium text-text">Jane Doe</div>
          <div className="text-sm text-text-muted">Sales Representative</div>
        </div>
      </div>

      <div className="font-mono text-[13px] leading-relaxed text-text-muted">
        6/25/2026 5:00 PM –<br />
        6/25/2026 6:00 PM
      </div>

      <div>
        <OutcomeBadge outcome="lost" />
      </div>
    </aside>
  );
}

function Avatar() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border-strong bg-surface-2 font-mono text-sm font-medium text-text">
      M
    </div>
  );
}

export function CallReviewPage() {
  return (
    <div className="flex h-screen bg-bg text-text">
      <Sidebar />

      <div className="relative flex-1">
        <ReactFlow
          nodes={initialNodes}
          edges={initialEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.5}
            color="var(--color-border)"
          />
          <MiniMap
            pannable
            zoomable
            maskColor="rgba(13,16,20,0.7)"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
            }}
            nodeColor={(n) =>
              (n.data as { kind?: string })?.kind === "ai"
                ? "var(--color-accent)"
                : "var(--color-border-strong)"
            }
            nodeStrokeWidth={0}
          />
          <Panel position="top-right" className="flex items-center gap-3">
            <button className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-150 hover:brightness-110 active:scale-[0.98]">
              Summarize Call
            </button>
            <Avatar />
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}
