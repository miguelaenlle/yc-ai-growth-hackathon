import type { Node, Edge } from "@xyflow/react";

// Hardcoded Call Review tree — a visual stand-in (no backend). Builds on the
// Convex example: a real recorded "spine" (the lost call) plus AI-explored
// alternative branches, each scored by a success probability.

export interface CallNodeData {
  kind: "real" | "ai";
  title: string;
  description?: string;
  success?: number; // 0..1, AI nodes only → signal ramp
  onPath?: boolean; // on the real recorded path
  [key: string]: unknown;
}

interface RawNode {
  id: string;
  kind: "real" | "ai";
  title: string;
  description?: string;
  success?: number;
  onPath?: boolean;
  children?: RawNode[];
}

// ---- The tree (parent → children). ~40 nodes. -----------------------------
const TREE: RawNode = {
  id: "opening", kind: "real", title: "Opening", onPath: true,
  description: "Thanks for hopping on, John",
  children: [
    {
      id: "discovery", kind: "real", title: "Discovery", onPath: true,
      description: "How's ticket volume lately?",
      children: [
        // --- Real spine continues through Pushback ---
        {
          id: "pushback", kind: "real", title: "Pushback", onPath: true,
          description: "You don't have Tableau integration",
          children: [
            {
              id: "roadmap", kind: "real", title: "On the roadmap", onPath: true,
              description: "It's an upcoming feature",
              children: [
                {
                  id: "deal_lost", kind: "real", title: "Deal lost", onPath: true,
                  description: "Send the roadmap",
                  children: [
                    { id: "lost_followup", kind: "ai", title: "Win-back", success: 0.18,
                      description: "Re-engage next quarter" },
                  ],
                },
              ],
            },
            {
              id: "alternative", kind: "ai", title: "Alternative", success: 0.8,
              description: "Use our SQL connectors instead",
              children: [
                {
                  id: "continue", kind: "ai", title: "Continue", success: 0.86,
                  description: "That works",
                  children: [
                    { id: "book_demo", kind: "ai", title: "Book demo", success: 0.93,
                      description: "Let's get it on the calendar",
                      children: [
                        { id: "demo_prep", kind: "ai", title: "Demo prep", success: 0.9,
                          description: "Tailor to ticket dashboards" },
                        { id: "loop_champion", kind: "ai", title: "Loop in champion", success: 0.88,
                          description: "Bring the VP along" },
                      ],
                    },
                    { id: "pricing", kind: "ai", title: "Pricing ask", success: 0.74,
                      description: "What does this run us?",
                      children: [
                        { id: "discount", kind: "ai", title: "Offer discount", success: 0.7,
                          description: "Annual prepay incentive" },
                        { id: "roi_case", kind: "ai", title: "ROI case", success: 0.82,
                          description: "Tie price to saved hours",
                          children: [
                            { id: "cfo", kind: "ai", title: "CFO buy-in", success: 0.8,
                              description: "Budget approved" },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "skeptical", kind: "ai", title: "Still skeptical", success: 0.55,
                  description: "Sounds like extra work",
                  children: [
                    { id: "live_walkthrough", kind: "ai", title: "Live walkthrough", success: 0.68,
                      description: "Show it in 5 minutes" },
                  ],
                },
              ],
            },
            {
              id: "customization", kind: "ai", title: "Customization", success: 0.5,
              description: "We'll build it next week",
              children: [
                {
                  id: "needs_proof", kind: "ai", title: "Needs proof", success: 0.45,
                  description: "I'll believe it when I see it",
                  children: [
                    { id: "case_study", kind: "ai", title: "Share case study", success: 0.6,
                      description: "Similar team, shipped fast" },
                    { id: "scope_risk", kind: "ai", title: "Scope risk", success: 0.32,
                      description: "Timeline slips, trust erodes" },
                  ],
                },
              ],
            },
          ],
        },
        // --- AI branch off Discovery: quantify the pain ---
        {
          id: "quantify", kind: "ai", title: "Quantify pain", success: 0.72,
          description: "How many tickets per week?",
          children: [
            {
              id: "pain_big", kind: "ai", title: "Pain is big", success: 0.84,
              description: "We're drowning in them",
              children: [
                { id: "urgency", kind: "ai", title: "Build urgency", success: 0.87,
                  description: "Every week costs you",
                  children: [
                    { id: "exec_intro", kind: "ai", title: "Exec intro", success: 0.9,
                      description: "Get the COO in the room",
                      children: [
                        { id: "proposal", kind: "ai", title: "Proposal sent", success: 0.92,
                          description: "Mutual action plan" },
                        { id: "negotiate", kind: "ai", title: "Negotiate terms", success: 0.85,
                          description: "Land the annual deal" },
                      ],
                    },
                  ],
                },
                { id: "quick_win", kind: "ai", title: "Quick win", success: 0.8,
                  description: "Pilot on one queue",
                  children: [
                    { id: "expand", kind: "ai", title: "Expand pilot", success: 0.82,
                      description: "Roll out to all queues" },
                  ],
                },
              ],
            },
            {
              id: "pain_small", kind: "ai", title: "Pain is minor", success: 0.4,
              description: "It's manageable for now",
              children: [
                { id: "nurture", kind: "ai", title: "Nurture", success: 0.38,
                  description: "Check back next quarter" },
              ],
            },
          ],
        },
      ],
    },
    // --- AI branch off Opening: stronger reframe ---
    {
      id: "reframe", kind: "ai", title: "Reframe value", success: 0.6,
      description: "Lead with outcomes, not features",
      children: [
        {
          id: "agenda", kind: "ai", title: "Set agenda", success: 0.66,
          description: "Align on what success looks like",
          children: [
            { id: "discovery_deep", kind: "ai", title: "Deep discovery", success: 0.78,
              description: "Map the whole workflow",
              children: [
                { id: "multithread", kind: "ai", title: "Multithread", success: 0.83,
                  description: "Find a second champion",
                  children: [
                    { id: "group_demo", kind: "ai", title: "Group demo", success: 0.86,
                      description: "Whole team in the room" },
                  ],
                },
                { id: "tech_eval", kind: "ai", title: "Tech eval", success: 0.7,
                  description: "Security & integration review",
                  children: [
                    { id: "security", kind: "ai", title: "Security signoff", success: 0.74,
                      description: "Passes their review" },
                  ],
                },
              ],
            },
            { id: "rapport", kind: "ai", title: "Build rapport", success: 0.58,
              description: "Earn the room first",
              children: [
                { id: "next_steps", kind: "ai", title: "Next steps", success: 0.6,
                  description: "Agree on a follow-up" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ---- Tidy left-to-right layout (center parents over their children's spans) -
const LEVEL_GAP = 300; // horizontal gap per depth level
const SIBLING_GAP = 110; // vertical slot per leaf

// Base node box — the size at full fish-eye scale (s = 1).
export const BASE_W = 240;
export const BASE_H = 104;

interface Positioned {
  node: RawNode;
  cross: number; // vertical position (sibling axis)
  depth: number; // horizontal level
}

function layout(root: RawNode): Positioned[] {
  const out: Positioned[] = [];
  let cursor = 0; // next free leaf slot (in SIBLING_GAP units)

  function place(node: RawNode, depth: number): number {
    if (!node.children || node.children.length === 0) {
      const cross = cursor * SIBLING_GAP;
      cursor += 1;
      out.push({ node, cross, depth });
      return cross;
    }
    const childCross = node.children.map((c) => place(c, depth + 1));
    const cross = (childCross[0] + childCross[childCross.length - 1]) / 2;
    out.push({ node, cross, depth });
    return cross;
  }

  place(root, 0);
  return out;
}

// ---- Derive React Flow nodes + edges --------------------------------------
function build(): { nodes: Node<CallNodeData>[]; edges: Edge[] } {
  const positioned = layout(TREE);
  const nodes: Node<CallNodeData>[] = positioned.map(({ node, cross, depth }) => ({
    id: node.id,
    type: "call",
    position: { x: depth * LEVEL_GAP, y: cross },
    data: {
      kind: node.kind,
      title: node.title,
      description: node.description,
      success: node.success,
      onPath: node.onPath,
      depth,
    },
    width: BASE_W,
    height: BASE_H,
  }));

  const edges: Edge[] = [];
  const walk = (node: RawNode) => {
    for (const child of node.children ?? []) {
      const onPath = node.onPath && child.onPath;
      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        animated: child.kind === "ai",
        style: {
          stroke: onPath ? "var(--color-accent)" : "var(--color-border-strong)",
          strokeWidth: onPath ? 2 : 1.5,
        },
      });
      walk(child);
    }
  };
  walk(TREE);

  return { nodes, edges };
}

export const { nodes: initialNodes, edges: initialEdges } = build();
export const NODE_COUNT = initialNodes.length;

// Each node's fixed center (from layout) — fish-eye pins centers and only
// varies size, so the tree shape stays stable.
export const BASE_CENTERS: Record<string, { x: number; y: number }> =
  Object.fromEntries(
    initialNodes.map((n) => [
      n.id,
      { x: n.position.x + BASE_W / 2, y: n.position.y + BASE_H / 2 },
    ]),
  );
