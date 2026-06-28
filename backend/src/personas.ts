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
