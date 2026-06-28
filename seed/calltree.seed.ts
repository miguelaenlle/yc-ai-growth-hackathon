// calltree.seed.ts — HAND-EDITABLE source of truth for the demo data.
//
// This file describes ONE canonical "move graph" (the master tree) and a
// population of calls that traverse it. `seed/build.ts` turns it into:
//   - backend/src/data/seed.json          (the backend SeedStore)
//   - frontend/src/data/tree.generated.ts (the static review-screen RawNode tree)
//
// Each call gets its OWN distinct tree (a per-prospect, pruned view of the master
// graph) so the past-calls list reads like a real pipeline of different companies.
// There are NO probabilities here on purpose — node win-rates and EVs are DERIVED
// from the call outcomes below, aggregated PER MOVE across the whole population and
// Beta-smoothed by the builder. Real branching/transcripts come later, at the point
// of file upload; this seed is fully deterministic synthetic data (no LLM needed).
//
// Edit the tree shape / archetype counts / prospects here, then run `npm run seed`.
// Never hand-edit the generated files.

import type { AiFeedback } from "../backend/src/types.js";

// Default deal value for newly-created live calls (no prospect context yet). Seed
// calls use their prospect's own dealValue = seats * PER_SEAT (see prospects).
export const dealValue = 45000;

// Our org — the thing the rep sells. NOT a prospect; this is branding only.
export const sellerOrg = { name: "Slack" };

// $/seat/yr. dealValue = seats * PER_SEAT (250 seats → $45k, the classic deal).
export const PER_SEAT = 180;

// The hero call's buyer is pinned (the cached hero transcript names her), so it
// must stay consistent across regenerations.
export const heroBuyer = {
  id: "buy_sarah",
  name: "Sarah Chen",
  title: "VP of Operations",
  personaId: "buy_sam", // status-quo defender — the knock-loss buyer who shuts down
};

// 5 reps. The UI features ONE (Jane); the others exist so the data reads like a
// team. Calls are biased toward Jane (see build.ts) so her pipeline is rich.
export const salespeople = [
  { id: "sp_jane", name: "Jane Doe" },
  { id: "sp_marcus", name: "Marcus Reid" },
  { id: "sp_dana", name: "Dana Wu" },
  { id: "sp_olivia", name: "Olivia Grant" },
  { id: "sp_ben", name: "Ben Harris" },
];

export const FEATURED_SALESPERSON_ID = "sp_jane";

// ---------------------------------------------------------------------------
// Prospects — believable Slack adopters. Each call is assigned one; its name is
// what shows in the past-calls list, and `incumbent`/`seats` template the tree
// copy. `hasChatIncumbent: false` = greenfield (no competing chat tool), so those
// only get price-led deals, not incumbent-objection deals.
// ---------------------------------------------------------------------------
export interface Prospect {
  id: string; // company id (used as call.companyId)
  name: string;
  industry: string;
  seats: number;
  incumbent: string; // the tool they currently use that Slack would displace
  hasChatIncumbent: boolean;
}

export const prospects: Prospect[] = [
  { id: "co_sundial", name: "Sundial Commerce", industry: "E-commerce", seats: 250, incumbent: "Microsoft Teams", hasChatIncumbent: true },
  { id: "co_northwind", name: "Northwind Logistics", industry: "Supply-chain SaaS", seats: 250, incumbent: "Microsoft Teams", hasChatIncumbent: true },
  { id: "co_meridian", name: "Meridian Labs", industry: "AI research", seats: 80, incumbent: "Discord", hasChatIncumbent: true },
  { id: "co_lumen", name: "Lumen Health", industry: "Telehealth", seats: 140, incumbent: "Google Chat", hasChatIncumbent: true },
  { id: "co_pixel", name: "Pixel & Co", industry: "Design agency", seats: 45, incumbent: "email threads", hasChatIncumbent: false },
  { id: "co_cobalt", name: "Cobalt Finance", industry: "Fintech", seats: 600, incumbent: "Microsoft Teams", hasChatIncumbent: true },
  { id: "co_driftwave", name: "Driftwave", industry: "Consumer mobile", seats: 60, incumbent: "Discord", hasChatIncumbent: true },
  { id: "co_arboretum", name: "Arboretum", industry: "Climate tech", seats: 110, incumbent: "Google Chat", hasChatIncumbent: true },
  { id: "co_vantage", name: "Vantage Security", industry: "Cybersecurity", seats: 90, incumbent: "a legacy chat tool", hasChatIncumbent: true },
  { id: "co_quill", name: "Quill", industry: "Media SaaS", seats: 200, incumbent: "Google Chat", hasChatIncumbent: true },
  { id: "co_helio", name: "Helio Robotics", industry: "Robotics", seats: 150, incumbent: "Microsoft Teams", hasChatIncumbent: true },
];

// Pinned prospects for the two curated demo calls (kept 250-seat / Teams so the
// shared tree_slack + cached hero transcript stay consistent).
export const SHOWCASE_PROSPECT_ID = "co_sundial";
export const HERO_PROSPECT_ID = "co_northwind";

/** Whose words/decision a node represents. */
export type Speaker = "seller" | "buyer";

/**
 * A node in the master move graph. `key` is the stable node id (already
 * `n_`-prefixed) AND the "move id" the population win-rate is aggregated under.
 * `title` + `descTpl` are the deterministic card copy; `descTpl` may contain
 * `{incumbent}` / `{seats}` placeholders, substituted per prospect at build time.
 * `intent` is kept only to seed the cached LLM hero transcript. NO probabilities.
 */
export interface SeedTreeNode {
  key: string;
  speaker: Speaker;
  title: string;
  descTpl: string;
  intent: string;
  children?: SeedTreeNode[];
}

// The master move graph (S = seller, B = buyer). Slack vs. an incumbent chat tool,
// with a parallel price branch. Every seller fork is a plausible move; the two
// "weak" plays (n_knock, n_discount) are real mistakes a rep could make.
export const tree: SeedTreeNode = {
  key: "n_open", speaker: "seller", title: "Warm Opening", descTpl: "Open warm, set a light agenda",
  intent: "Warm opening — thank the buyer for the time and set a light agenda.",
  children: [
    {
      key: "n_disc", speaker: "seller", title: "Discovery", descTpl: "How does your team communicate today?",
      intent: "Discovery: ask how the team communicates and collaborates today.",
      children: [
        {
          key: "n_incumbent", speaker: "buyer", title: "Incumbent Objection", descTpl: "We already use {incumbent}",
          intent: "Incumbent objection: the buyer already uses a competing chat tool.",
          children: [
            {
              key: "n_coexist", speaker: "seller", title: "Coexist Reframe", descTpl: "Slack runs alongside {incumbent}, not a rip-and-replace",
              intent: "Reframe: Slack can run alongside the incumbent; it's not a rip-and-replace.",
              children: [
                {
                  key: "n_curious", speaker: "buyer", title: "Curious Buyer", descTpl: "Where does Slack win over {incumbent}?",
                  intent: "Buyer warms up and asks where Slack actually wins.",
                  children: [
                    {
                      key: "n_pilot", speaker: "seller", title: "Pilot Offer", descTpl: "Low-risk 2-week pilot with one team",
                      intent: "Propose a low-risk 2-week pilot with one team.",
                      children: [
                        { key: "n_yes", speaker: "buyer", title: "Pilot Agreement", descTpl: "Buyer agrees to run the pilot", intent: "Buyer agrees to run the pilot. (deal won)" },
                      ],
                    },
                  ],
                },
                {
                  key: "n_unconvinced", speaker: "buyer", title: "Pushback", descTpl: "We just standardized on {incumbent} — not now",
                  intent: "Buyer pushes back: just standardized on the incumbent. (deal lost)",
                },
              ],
            },
            {
              key: "n_discover", speaker: "seller", title: "Discovery First", descTpl: "What's painful about {incumbent} day-to-day?",
              intent: "Discovery-first: ask what about the incumbent is actually painful.",
              children: [
                {
                  key: "n_pain", speaker: "buyer", title: "Real Pain", descTpl: "Search is weak, threads get lost",
                  intent: "Buyer admits real pain: search is weak and threads get lost.",
                  children: [
                    {
                      key: "n_show", speaker: "seller", title: "Show Solution", descTpl: "Tie pain to Slack's search + threads",
                      intent: "Tie the pain to Slack's search + threads and offer a demo.",
                      children: [
                        { key: "n_demo", speaker: "buyer", title: "Demo Booked", descTpl: "Buyer books a demo", intent: "Buyer books a demo. (deal won)" },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              key: "n_knock", speaker: "seller", title: "Weak Move", descTpl: "{incumbent} is clunky and outdated",
              intent: "Disparage the incumbent as clunky and outdated — a weak, dismissive move.",
              children: [
                {
                  key: "n_defensive", speaker: "buyer", title: "Defensive Buyer", descTpl: "Just send me some info",
                  intent: "Buyer gets defensive and disengages. (deal lost)",
                },
              ],
            },
          ],
        },
        {
          key: "n_price", speaker: "buyer", title: "Price Inquiry", descTpl: "What does this run for {seats} people?",
          intent: "Buyer jumps to cost for their team size.",
          children: [
            {
              key: "n_value", speaker: "seller", title: "Value Anchor", descTpl: "Time saved per seat, not sticker price",
              intent: "Anchor on value — time saved per seat, not sticker price.",
              children: [
                {
                  key: "n_proof", speaker: "buyer", title: "Proof Request", descTpl: "Need proof it pays off at our size",
                  intent: "Buyer wants proof it pays off at their size.",
                  children: [
                    {
                      key: "n_caseclose", speaker: "buyer", title: "Case Study Success", descTpl: "Relevant case study lands, buyer moves forward",
                      intent: "A relevant case study lands and the buyer moves forward. (deal won)",
                    },
                  ],
                },
                {
                  key: "n_pushprice", speaker: "buyer", title: "Price Resistance", descTpl: "Buyer balks at the price",
                  intent: "Buyer still balks at the price. (deal lost)",
                },
              ],
            },
            {
              key: "n_discount", speaker: "seller", title: "Discount Offer", descTpl: "Lead with a discount to win",
              intent: "Lead with a discount to win the deal — a weak, margin-eroding move.",
              children: [
                {
                  key: "n_anchor", speaker: "buyer", title: "Buyer Anchors", descTpl: "Buyer anchors lower and stalls",
                  intent: "Buyer anchors even lower and stalls. (no decision — still open)",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export type Outcome = "won" | "lost" | "open";

/** A family of identical calls — `count` reps walking the same path to `outcome`. */
export interface Archetype {
  key: string; // archetype label (A..G)
  path: string[]; // contiguous root→leaf node keys
  outcome: Outcome;
  count: number;
  /** Whether this archetype centers on the incumbent fork (true) or price fork. */
  incumbentShape: boolean;
}

// ~100 calls. Counts chosen so per-move win-rates read realistically:
// incumbent ≈70%, coexist ≈79%, knock ≈7%, price ≈43%, value ≈65%, overall ≈61%.
export const calls: Archetype[] = [
  { key: "A", outcome: "won",  count: 33, incumbentShape: true,  path: ["n_open", "n_disc", "n_incumbent", "n_coexist", "n_curious", "n_pilot", "n_yes"] },
  { key: "B", outcome: "lost", count: 8,  incumbentShape: true,  path: ["n_open", "n_disc", "n_incumbent", "n_coexist", "n_unconvinced"] },
  { key: "C", outcome: "won",  count: 14, incumbentShape: true,  path: ["n_open", "n_disc", "n_incumbent", "n_discover", "n_pain", "n_show", "n_demo"] },
  { key: "D", outcome: "lost", count: 12, incumbentShape: true,  path: ["n_open", "n_disc", "n_incumbent", "n_knock", "n_defensive"] },
  { key: "E", outcome: "won",  count: 14, incumbentShape: false, path: ["n_open", "n_disc", "n_price", "n_value", "n_proof", "n_caseclose"] },
  { key: "F", outcome: "lost", count: 7,  incumbentShape: false, path: ["n_open", "n_disc", "n_price", "n_value", "n_pushprice"] },
  { key: "G", outcome: "open", count: 12, incumbentShape: false, path: ["n_open", "n_disc", "n_price", "n_discount", "n_anchor"] },
];

// The hero call (full LLM transcript + AI feedback + a mock recording) is one of
// the knock-loss calls — the demo's "this is the moment it slipped".
export const hero = "D";

// Buyer persona pools per archetype, so a rep's calls show varied buyers. The AI
// plays the assigned persona in practice (never user-picked). Synthetic for now;
// an LLM will infer the persona from the real transcript later.
export const personaByArchetype: Record<string, string[]> = {
  A: ["buy_charlie", "buy_polly", "buy_nina"],
  B: ["buy_sam", "buy_greg"],
  C: ["buy_tina", "buy_ed"],
  D: ["buy_steve", "buy_sam"],
  E: ["buy_ed", "buy_charlie"],
  F: ["buy_bob", "buy_nate"],
  G: ["buy_nate", "buy_bob", "buy_greg"],
};

// ---------------------------------------------------------------------------
// Showcase call — hand-authored, the BEST "Summarize Call" demo. Kept identical
// (buyer Rachel Kim, this transcript, this feedback, the full tree_slack tree).
// It walks the full 7-node winning line and tops the past-calls list.
// ---------------------------------------------------------------------------
export const showcase: {
  callId: string;
  archetype: string; // which archetype's path it follows (must be a WON path)
  prospectId: string;
  buyer: { id: string; name: string; title: string; personaId: string };
  salespersonId: string;
  transcript: { speaker: Speaker; text: string }[];
  feedback: AiFeedback;
} = {
  callId: "call_showcase",
  archetype: "A",
  prospectId: SHOWCASE_PROSPECT_ID,
  buyer: { id: "buy_rachel", name: "Rachel Kim", title: "VP of Engineering", personaId: "buy_polly" },
  salespersonId: "sp_jane",
  transcript: [
    { speaker: "seller", text: "Hey Rachel, thanks for making the time — I know you're heads-down shipping, so I'll keep this useful." },
    { speaker: "buyer", text: "Appreciate it. We're slammed, but I carved out twenty minutes." },
    { speaker: "seller", text: "Perfect. Before I pitch anything — how's your team actually communicating day to day right now?" },
    { speaker: "buyer", text: "Mostly Microsoft Teams. It came bundled with our license, so that's just where everyone landed." },
    { speaker: "seller", text: "Totally makes sense, and to be clear I'm not here to rip Teams out — most of our customers run Slack right alongside it." },
    { speaker: "buyer", text: "Okay, that's good to hear. So where does Slack actually win for a team like mine?" },
    { speaker: "seller", text: "Search and threads. Engineering decisions stop getting buried, and your incidents and deploys can pipe straight into channels." },
    { speaker: "buyer", text: "The buried-threads thing is real. We lose decisions in Teams all the time." },
    { speaker: "seller", text: "That's exactly what we fix. What if we ran a two-week pilot with one squad — no migration, no commitment?" },
    { speaker: "buyer", text: "One team, two weeks… yeah, that's low-risk enough that I can say yes to it." },
    { speaker: "seller", text: "Love it. I'll spin up the workspace and get your platform squad in today." },
    { speaker: "buyer", text: "Let's do it. If search is as good as you say, this'll be an easy expansion conversation." },
  ],
  feedback: {
    summary:
      "A disciplined coexistence play, start to finish. You refused to bash Teams, reframed to running alongside it, mirrored the buyer's own pain — buried decisions — and closed a concrete, low-risk pilot. This is the line to copy.",
    strengths: [
      "Didn't knock the incumbent — reframed to coexistence",
      "Surfaced the buried-threads pain in the buyer's own words before pitching",
      "Closed a specific, low-risk next step (a two-week one-squad pilot)",
    ],
    weaknesses: [
      "Left value unquantified — a dollar figure on lost decisions would have anchored EV higher",
      "Could have set the expansion frame earlier instead of at the very end",
    ],
    practiceTargets: [
      {
        nodeId: "n_curious",
        reason: "The buyer asked where Slack wins — a prime moment to quantify the cost of buried decisions.",
        drill: "Tie the buried-threads pain to hours lost per week, then to dollars.",
        metric: "enthusiasm",
        score: 0.3,
      },
    ],
  },
};
