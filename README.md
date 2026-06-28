<!-- SAVEPOINT: animations snappy, mock calls terminate, AI-acing-sales works -->
# CallTree — YC AI Growth Hackathon

CallTree turns every sales call into a decision tree, then lets reps rewind to
the moment a deal turned and practice a better path — scored by real win-rate
and expected value. See [`context/calltree-product-overview.md`](context/calltree-product-overview.md)
for the full pitch.

## Status

Scaffold stage:

- **Backend** — single Express process serving the [API contract](context/calltree-api-contract.md)
  on `:3001`. Read endpoints serve the real seed data; lifecycle / realtime /
  agent endpoints return contract-shaped **dummy** responses (marked `TODO(real)`).
- **Frontend** — Vite + React + TS with the libraries we'll build on installed
  and a **placeholder page**. The real UI is not started yet.

## Layout

```
context/    product overview, API contract, and seed data (source of truth)
backend/    Express scaffold — dummy data adhering to the contract
frontend/   Vite + React placeholder
```

## Run

Backend:

```bash
cd backend
npm install
npm run dev      # http://localhost:3001
```

Frontend (proxies API calls to :3001 in dev):

```bash
cd frontend
npm install
npm run dev
```

## Contract

The backend implements all 15 endpoints in
[`context/calltree-api-contract.md`](context/calltree-api-contract.md). Types in
`backend/src/types.ts` are transcribed verbatim from §2 of the contract. The
seed store (`backend/src/data/seed.json`) is the one seeded Convex call the demo
runs on.
