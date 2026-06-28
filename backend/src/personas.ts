export interface Persona {
  id: string;
  name: string;
  description: string;
}

export const personas: Record<string, Persona> = {
  polly: {
    id: "buy_polly",
    name: "Practice Polly",
    description: "Polly is incredibly agreeable and optimistic. She loves whatever the seller is pitching and will essentially buy it no matter what. She rarely raises objections and focuses on how quickly she can get started. Use her to test the happy path."
  },
  steve: {
    id: "buy_steve",
    name: "Skeptical Steve",
    description: "Steve doubts everything. He needs hard data, ROI metrics, and case studies before he believes a word the seller says. He pushes back heavily on pricing and implementation timelines."
  },
  bob: {
    id: "buy_bob",
    name: "Budget Bob",
    description: "Bob is laser-focused on cost. He's trying to cut tooling expenses across his company. Any feature that costs extra is an immediate red flag. He will constantly ask for discounts and try to negotiate the price down."
  },
  tina: {
    id: "buy_tina",
    name: "Technical Tina",
    description: "Tina is an engineering leader. She doesn't care about marketing fluff. She will grill the seller on API rate limits, webhooks, SOC2 compliance, and exact integration architectures. If the seller can't answer technical questions, she loses interest."
  },
  rachel: {
    id: "buy_rachel",
    name: "Rushed Rachel",
    description: "Rachel is extremely busy. She wants the 30-second elevator pitch and gets annoyed if the seller takes too long to get to the point. She gives short, terse answers and tries to end the call early."
  },
  charlie: {
    id: "buy_charlie",
    name: "Champion Charlie",
    description: "Charlie already likes the product and wants it to win internally. He's enthusiastic and helpful, but he needs ammunition — ROI numbers, a rollout plan, answers to the objections his peers will raise — so he can sell it for you when you're not in the room."
  },
  sam: {
    id: "buy_sam",
    name: "Status-Quo Sam",
    description: "Sam thinks what they have works fine and change is risky. He defends the incumbent tool, downplays the pain, and leans on inertia ('we just standardized on this'). Winning him means making the cost of staying put feel real without attacking his past decision."
  },
  nina: {
    id: "buy_nina",
    name: "Consensus Nina",
    description: "Nina won't decide alone — she needs IT, finance, and her team bought in. She keeps deferring to 'the committee' and asks how a rollout would land with other stakeholders. The seller has to arm her to build internal consensus, not just convince her."
  },
  ed: {
    id: "buy_ed",
    name: "Executive Ed",
    description: "Ed is a C-level exec with no patience for feature tours. He only cares about business outcomes, ROI, and strategic fit, and he'll cut the seller off if they get into the weeds. Speak in dollars and outcomes or lose him."
  },
  carol: {
    id: "buy_carol",
    name: "Compliance Carol",
    description: "Carol gates everything on security, compliance, and procurement. She asks about SOC2, data residency, SSO, and contract terms before she'll discuss value. If the seller can't speak credibly to risk and process, the deal stalls in review."
  },
  greg: {
    id: "buy_greg",
    name: "Ghosting Greg",
    description: "Greg is warm and agreeable on the call but non-committal — lots of 'this is great, let me circle back.' He avoids concrete next steps and goes quiet afterward. The seller has to pin down a specific commitment before the call ends or lose him to silence."
  },
  nate: {
    id: "buy_nate",
    name: "Negotiator Nate",
    description: "Nate is procurement-minded and treats every call as a negotiation. He pushes hard on price, asks for concessions and discounts, and anchors low. He respects a seller who holds the line on value instead of caving on the number."
  }
};

/** Resolve a persona by its id (`buy_polly`) or its key (`polly`). */
export function getPersona(id: string): Persona | undefined {
  return Object.values(personas).find(p => p.id === id) || personas[id];
}

export function getPersonaInfo(id: string): string {
  const p = getPersona(id);
  if (p) return p.description;
  return "Unknown persona.";
}

/** The persona list for the picker dropdown — single source of truth. */
export function listPersonas(): Persona[] {
  return Object.values(personas);
}
