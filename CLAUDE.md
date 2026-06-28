# CallTree — agent context

**Before doing any non-trivial work in this repo, read the three context files in
[`context/`](context/). They are the source of truth — code defers to them, not the
other way around.**

| File | What it is | Read it when |
|---|---|---|
| [`context/calltree-product-overview.md`](context/calltree-product-overview.md) | The product: problem, the Record→Map→Review→Practice loop, what's on screen, scope | Any feature/UX/product decision |
| [`context/calltree-api-contract.md`](context/calltree-api-contract.md) | Definitive API contract — types (§2), 15 endpoints (§3), the SSE `LiveEvent` stream (§4) | Any backend, frontend-data, or type work |
| [`context/calltree-seed.json`](context/calltree-seed.json) | Legacy seed reference. The live demo data (`backend/src/data/seed.json`, `frontend/src/data/tree.generated.ts`) is generated from `seed/` — edit `seed/calltree.seed.ts` and run `npm run seed`, never hand-edit the generated files | Any work touching data shapes or the demo |

## Ground rules

- **The contract is canonical.** `backend/src/types.ts` is transcribed verbatim from
  contract §2 — if a type changes, change the contract first, then mirror it. Don't
  invent fields or endpoints not in `calltree-api-contract.md`.
- **EV rule:** `expectedValue = round(successProbability * 45000)` (Slack is a $45k, 250-seat deal).
- **Scope:** hackathon — one user, local JSON store, single Express process on `:3001`.
  The goal is to demo the full loop end-to-end on the one seeded call, not to scale.
- **Current state:** backend read endpoints serve real seed data; lifecycle/realtime/agent
  endpoints are contract-shaped stubs marked `// TODO(real)`. The frontend is a placeholder —
  the real UI is not started. See [`README.md`](README.md).

## Layout

```
context/    product overview, API contract, seed data (SOURCE OF TRUTH)
backend/    Express scaffold (:3001) — dummy data adhering to the contract
frontend/   Vite + React + TS + Tailwind placeholder
```
