// PLACEHOLDER participant data for the call list. The list endpoint
// (CallSummary) doesn't carry buyer/salesperson, so we stub it here keyed by
// company name (values mirror the backend seed so the cards read true).
// TODO: replace with real data once /calls carries participants — the resolved
// buyer/salesperson already exist on GET /calls/:id (CallDetail).

export interface Person {
  name: string;
  title: string;
}

interface Participants {
  buyer: Person;
  salesperson: Person;
}

const BY_COMPANY: Record<string, Participants> = {
  Convex: {
    buyer: { name: "John Doe", title: "VP of Operations" },
    salesperson: { name: "Jane Doe", title: "Sales Representative" },
  },
  "NorthRidge Logistics": {
    buyer: { name: "Maria Lopez", title: "Head of Supply Chain" },
    salesperson: { name: "Jane Doe", title: "Sales Representative" },
  },
  "Helios Energy": {
    buyer: { name: "Sam Carter", title: "Director of IT" },
    salesperson: { name: "Dana Wu", title: "Account Executive" },
  },
  "BrightWave Media": {
    buyer: { name: "Priya Nair", title: "Chief Marketing Officer" },
    salesperson: { name: "Marcus Reid", title: "Senior Account Executive" },
  },
  "Atlas Manufacturing": {
    buyer: { name: "Tom Becker", title: "Chief Operating Officer" },
    salesperson: { name: "Jane Doe", title: "Sales Representative" },
  },
  "Vertex Financial": {
    buyer: { name: "Lena Park", title: "VP of Engineering" },
    salesperson: { name: "Dana Wu", title: "Account Executive" },
  },
};

const FALLBACK: Participants = {
  buyer: { name: "Alex Morgan", title: "Decision Maker" },
  salesperson: { name: "Sam Rivera", title: "Account Executive" },
};

export function participantsFor(company: string): Participants {
  return BY_COMPANY[company] ?? FALLBACK;
}
