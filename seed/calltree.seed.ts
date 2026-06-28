// calltree.seed.ts — HAND-EDITABLE source of truth for the demo data.
//
// This file describes ONE canonical decision tree and the population of calls
// that traverse it. `seed/build.ts` turns it into:
//   - backend/src/data/seed.json          (the backend SeedStore)
//   - frontend/src/data/tree.generated.ts (the review-screen RawNode tree)
//
// There are NO probabilities here on purpose — node win-rates and EVs are
// DERIVED from the call outcomes below (Beta-smoothed) by the builder. Edit the
// tree shape / archetype counts here, then run `npm run seed`. Never hand-edit
// the generated files.

export const dealValue = 45000;

export const company = { id: "co_slack", name: "Slack" };

// The hero call's buyer is pinned (the cached hero transcript names her), so it
// must stay consistent across regenerations.
export const heroBuyer = { id: "buy_sarah", name: "Sarah Chen", title: "VP of Operations" };

// 5 reps; calls rotate through them so the past-calls list reads like a team's
// history. The hero call keeps Jane Doe.
export const salespeople = [
  { id: "sp_jane", name: "Jane Doe" },
  { id: "sp_marcus", name: "Marcus Reid" },
  { id: "sp_dana", name: "Dana Wu" },
  { id: "sp_olivia", name: "Olivia Grant" },
  { id: "sp_ben", name: "Ben Harris" },
];

// Name pools for the generated prospect buyers. 12 firsts × 5 lasts = 60 unique
// (first[i % 12] + last[floor(i / 12)]); the builder makes 59 (the hero is Sarah).
export const buyerFirstNames = [
  "Maria", "Sam", "Priya", "Tom", "Lena", "David",
  "Aisha", "Carlos", "Nina", "Raj", "Emma", "Kevin",
];
export const buyerLastNames = ["Lopez", "Carter", "Nair", "Becker", "Park"];
export const buyerTitles = [
  "VP of Operations", "Head of IT", "Director of Engineering",
  "COO", "VP of People", "Head of Customer Success",
];

/** Whose words/decision a node represents. */
export type Speaker = "seller" | "buyer";

/**
 * A node in the canonical tree. `key` is the stable node id (already `n_`-prefixed).
 * `intent` is a short brief of what happens at this beat — it seeds the LLM copy
 * pass that writes the node's title + description. NO probabilities live here.
 */
export interface SeedTreeNode {
  key: string;
  speaker: Speaker;
  intent: string;
  children?: SeedTreeNode[];
}

// The 22-node tree (S = seller, B = buyer). Slack vs. an incumbent (MS Teams),
// with a parallel price branch. Every seller fork is a plausible move; the two
// "weak" plays (n_knock, n_discount) are real mistakes a rep could make, not
// strawmen.
export const tree: SeedTreeNode = {
  key: "n_open", speaker: "seller", intent: "Warm opening — thank Sarah for the time and set a light agenda.",
  children: [
    {
      key: "n_disc", speaker: "seller", intent: "Discovery: ask how the team communicates and collaborates today.",
      children: [
        {
          key: "n_incumbent", speaker: "buyer",
          intent: "Incumbent objection: \"We already use Microsoft Teams — it's bundled with our license.\"",
          children: [
            {
              key: "n_coexist", speaker: "seller",
              intent: "Reframe: Slack can run alongside Teams; it's not a rip-and-replace.",
              children: [
                {
                  key: "n_curious", speaker: "buyer",
                  intent: "Buyer warms up and asks where Slack actually wins over Teams.",
                  children: [
                    {
                      key: "n_pilot", speaker: "seller",
                      intent: "Propose a low-risk 2-week pilot with one team.",
                      children: [
                        { key: "n_yes", speaker: "buyer", intent: "Buyer agrees to run the pilot. (deal won)" },
                      ],
                    },
                  ],
                },
                {
                  key: "n_unconvinced", speaker: "buyer",
                  intent: "Buyer pushes back: \"We just standardized on Teams — not now.\" (deal lost)",
                },
              ],
            },
            {
              key: "n_discover", speaker: "seller",
              intent: "Discovery-first: ask what about Teams is actually painful day to day.",
              children: [
                {
                  key: "n_pain", speaker: "buyer",
                  intent: "Buyer admits real pain: search is weak and threads get lost.",
                  children: [
                    {
                      key: "n_show", speaker: "seller",
                      intent: "Tie the pain to Slack's search + threads and offer a demo.",
                      children: [
                        { key: "n_demo", speaker: "buyer", intent: "Buyer books a demo. (deal won)" },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              key: "n_knock", speaker: "seller",
              intent: "Disparage Teams as clunky and outdated — a weak, dismissive move.",
              children: [
                {
                  key: "n_defensive", speaker: "buyer",
                  intent: "Buyer gets defensive: \"Just send me some info.\" (deal lost)",
                },
              ],
            },
          ],
        },
        {
          key: "n_price", speaker: "buyer",
          intent: "Buyer jumps to cost: \"What does this run for 250 people?\"",
          children: [
            {
              key: "n_value", speaker: "seller",
              intent: "Anchor on value — time saved per seat, not sticker price.",
              children: [
                {
                  key: "n_proof", speaker: "buyer",
                  intent: "Buyer wants proof it pays off at their size.",
                  children: [
                    {
                      key: "n_caseclose", speaker: "buyer",
                      intent: "A relevant case study lands and the buyer moves forward. (deal won)",
                    },
                  ],
                },
                {
                  key: "n_pushprice", speaker: "buyer",
                  intent: "Buyer still balks at the price. (deal lost)",
                },
              ],
            },
            {
              key: "n_discount", speaker: "seller",
              intent: "Lead with a discount to win the deal — a weak, margin-eroding move.",
              children: [
                {
                  key: "n_anchor", speaker: "buyer",
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
}

// ~60 calls. Counts chosen so derived win-rates read realistically:
// incumbent ≈65%, coexist ≈78%, knock ≈9%, price ≈45%, value ≈69%, overall ≈58%.
export const calls: Archetype[] = [
  { key: "A", outcome: "won",  count: 18, path: ["n_open", "n_disc", "n_incumbent", "n_coexist", "n_curious", "n_pilot", "n_yes"] },
  { key: "B", outcome: "lost", count: 5,  path: ["n_open", "n_disc", "n_incumbent", "n_coexist", "n_unconvinced"] },
  { key: "C", outcome: "won",  count: 8,  path: ["n_open", "n_disc", "n_incumbent", "n_discover", "n_pain", "n_show", "n_demo"] },
  { key: "D", outcome: "lost", count: 9,  path: ["n_open", "n_disc", "n_incumbent", "n_knock", "n_defensive"] },
  { key: "E", outcome: "won",  count: 9,  path: ["n_open", "n_disc", "n_price", "n_value", "n_proof", "n_caseclose"] },
  { key: "F", outcome: "lost", count: 4,  path: ["n_open", "n_disc", "n_price", "n_value", "n_pushprice"] },
  { key: "G", outcome: "open", count: 7,  path: ["n_open", "n_disc", "n_price", "n_discount", "n_anchor"] },
];

// The hero call (gets a full LLM transcript + AI feedback + a mock recording) is
// one of the knock-loss calls — the demo's "this is the moment it slipped".
export const hero = "D";
