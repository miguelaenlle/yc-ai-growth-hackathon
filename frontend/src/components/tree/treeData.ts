import type { Node, Edge } from "@xyflow/react";

// Hardcoded Call Review tree — a visual stand-in (no backend). Builds on the
// Convex example: a real recorded "spine" (the lost call) plus AI-explored
// alternative branches, each scored by a success probability.

export type Actor = "buyer" | "seller";

export interface CallNodeData {
  kind: "real" | "ai";
  title: string;
  description?: string;
  success?: number; // 0..1, AI nodes only → signal ramp
  onPath?: boolean; // on the real recorded path
  actor?: Actor;
  onSimulate?: () => void; // shown on the focused node → start a simulation here
  [key: string]: unknown;
}

// Whose words/decision each node represents.
const ACTOR: Record<string, Actor> = {
  opening: "seller", discovery: "seller", pushback: "buyer", roadmap: "seller",
  deal_lost: "buyer", lost_followup: "seller", alternative: "seller",
  continue: "buyer", book_demo: "seller", demo_prep: "seller",
  loop_champion: "seller", pricing: "buyer", discount: "seller",
  roi_case: "seller", cfo: "buyer", skeptical: "buyer",
  live_walkthrough: "seller", customization: "seller", needs_proof: "buyer",
  case_study: "seller", scope_risk: "buyer", quantify: "seller",
  pain_big: "buyer", urgency: "seller", exec_intro: "seller",
  proposal: "seller", negotiate: "seller", quick_win: "seller",
  expand: "seller", pain_small: "buyer", nurture: "seller",
  reframe: "seller", agenda: "seller", discovery_deep: "seller",
  multithread: "seller", group_demo: "seller", tech_eval: "seller",
  security: "buyer", rapport: "seller", next_steps: "seller",
};

export interface RawNode {
  id: string;
  kind: "real" | "ai";
  title: string;
  description?: string;
  success?: number;
  onPath?: boolean;
  children?: RawNode[];
}

// ---- The tree (parent → children). ~40 nodes. -----------------------------
export const TREE: RawNode = {
  id: "opening", kind: "real", title: "Thanks for hopping on", onPath: true,
  description: "Warm open with John",
  children: [
    {
      id: "discovery", kind: "real", title: "How's ticket volume?", onPath: true,
      description: "Surfacing the pain",
      children: [
        // --- Real spine continues through Pushback ---
        {
          id: "pushback", kind: "real", title: "No Tableau integration", onPath: true,
          description: "Their analytics team lives in it",
          children: [
            {
              id: "roadmap", kind: "real", title: "Tableau's on the roadmap", onPath: true,
              description: "Deflects to a future feature",
              children: [
                {
                  id: "deal_lost", kind: "real", title: "“Just send the deck”", onPath: true,
                  description: "Buyer disengages",
                  children: [
                    { id: "lost_followup", kind: "ai", title: "Re-engage next quarter", success: 0.18,
                      description: "Long-shot win-back" },
                  ],
                },
              ],
            },
            {
              id: "alternative", kind: "ai", title: "Use our SQL connectors", success: 0.8,
              description: "Pipe data in, keep Tableau",
              children: [
                {
                  id: "continue", kind: "ai", title: "“That works”", success: 0.86,
                  description: "Objection cleared",
                  children: [
                    { id: "book_demo", kind: "ai", title: "Book the demo", success: 0.93,
                      description: "Get it on the calendar",
                      children: [
                        { id: "demo_prep", kind: "ai", title: "Tailor to ticket dashboards", success: 0.9,
                          description: "Prep their use case" },
                        { id: "loop_champion", kind: "ai", title: "Bring the VP along", success: 0.88,
                          description: "Loop in the champion" },
                      ],
                    },
                    { id: "pricing", kind: "ai", title: "“What does this run us?”", success: 0.74,
                      description: "Buyer asks about price",
                      children: [
                        { id: "discount", kind: "ai", title: "Annual prepay discount", success: 0.7,
                          description: "Trade term for price" },
                        { id: "roi_case", kind: "ai", title: "Tie price to saved hours", success: 0.82,
                          description: "Build the ROI case",
                          children: [
                            { id: "cfo", kind: "ai", title: "Get CFO buy-in", success: 0.8,
                              description: "Budget approved" },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "skeptical", kind: "ai", title: "“Sounds like extra work”", success: 0.55,
                  description: "Still skeptical",
                  children: [
                    { id: "live_walkthrough", kind: "ai", title: "Show it in 5 minutes", success: 0.68,
                      description: "Live walkthrough" },
                  ],
                },
              ],
            },
            {
              id: "customization", kind: "ai", title: "“We'll build it next week”", success: 0.5,
              description: "Promise a custom integration",
              children: [
                {
                  id: "needs_proof", kind: "ai", title: "“Believe it when I see it”", success: 0.45,
                  description: "Buyer needs proof",
                  children: [
                    { id: "case_study", kind: "ai", title: "Share a case study", success: 0.6,
                      description: "Similar team, shipped fast" },
                    { id: "scope_risk", kind: "ai", title: "Timeline slips, trust erodes", success: 0.32,
                      description: "Risk of overpromising" },
                  ],
                },
              ],
            },
          ],
        },
        // --- AI branch off Discovery: quantify the pain ---
        {
          id: "quantify", kind: "ai", title: "How many tickets per week?", success: 0.72,
          description: "Quantify the pain",
          children: [
            {
              id: "pain_big", kind: "ai", title: "“We're drowning in them”", success: 0.84,
              description: "Pain is big",
              children: [
                { id: "urgency", kind: "ai", title: "Every week costs you", success: 0.87,
                  description: "Build urgency",
                  children: [
                    { id: "exec_intro", kind: "ai", title: "Get the COO in the room", success: 0.9,
                      description: "Exec intro",
                      children: [
                        { id: "proposal", kind: "ai", title: "Send a mutual action plan", success: 0.92,
                          description: "Proposal out" },
                        { id: "negotiate", kind: "ai", title: "Land the annual deal", success: 0.85,
                          description: "Negotiate terms" },
                      ],
                    },
                  ],
                },
                { id: "quick_win", kind: "ai", title: "Pilot on one queue", success: 0.8,
                  description: "Quick win",
                  children: [
                    { id: "expand", kind: "ai", title: "Roll out to all queues", success: 0.82,
                      description: "Expand the pilot" },
                  ],
                },
              ],
            },
            {
              id: "pain_small", kind: "ai", title: "“It's manageable for now”", success: 0.4,
              description: "Pain is minor",
              children: [
                { id: "nurture", kind: "ai", title: "Check back next quarter", success: 0.38,
                  description: "Nurture" },
              ],
            },
          ],
        },
      ],
    },
    // --- AI branch off Opening: stronger reframe ---
    {
      id: "reframe", kind: "ai", title: "Lead with outcomes", success: 0.6,
      description: "Reframe off features",
      children: [
        {
          id: "agenda", kind: "ai", title: "Align on what success looks like", success: 0.66,
          description: "Set the agenda",
          children: [
            { id: "discovery_deep", kind: "ai", title: "Map the whole workflow", success: 0.78,
              description: "Deep discovery",
              children: [
                { id: "multithread", kind: "ai", title: "Find a second champion", success: 0.83,
                  description: "Multithread the deal",
                  children: [
                    { id: "group_demo", kind: "ai", title: "Get the whole team in", success: 0.86,
                      description: "Group demo" },
                  ],
                },
                { id: "tech_eval", kind: "ai", title: "Security & integration review", success: 0.7,
                  description: "Tech evaluation",
                  children: [
                    { id: "security", kind: "ai", title: "Pass their security review", success: 0.74,
                      description: "Signoff secured" },
                  ],
                },
              ],
            },
            { id: "rapport", kind: "ai", title: "Earn the room first", success: 0.58,
              description: "Build rapport",
              children: [
                { id: "next_steps", kind: "ai", title: "Agree on a follow-up", success: 0.6,
                  description: "Lock next steps" },
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
// Reusable for any RawNode tree — the static seed (TREE) and trees built from
// backend data both flow through here, so visuals stay identical.
export function buildView(
  root: RawNode,
  actorOf: (id: string) => Actor | undefined,
): { nodes: Node<CallNodeData>[]; edges: Edge[] } {
  const positioned = layout(root);
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
      actor: actorOf(node.id),
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
  walk(root);

  return { nodes, edges };
}

export const { nodes: initialNodes, edges: initialEdges } = buildView(
  TREE,
  (id) => ACTOR[id],
);
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
