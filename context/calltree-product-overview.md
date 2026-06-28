# CallTree — Product Overview

**One line.** CallTree turns every sales call into a decision tree, then lets reps rewind to the moment a deal turned and practice a better path — scored by real win-rate and expected value.

## The problem

Reps learn slowly from calls. After a loss the lesson is fuzzy ("get better at objections"), and practice is generic role-play disconnected from what actually happened. Managers can't point to the exact moment a deal slipped, so coaching is vibes, not evidence.

## How it works

1. **Record** — a real call is captured and transcribed.
2. **Map** — CallTree lays the call out as a decision tree. Each question, objection, and response is a node; the real call traces one path down it.
3. **Review** — see the path you took, hover any node for its success probability and expected value, and get an AI walkthrough of what went well and what didn't.
4. **Practice** — click the moment it slipped and run a mock from there against an AI buyer. The tree scores each branch by win-rate and expected value, so you drill the move that actually converts — not whatever you feel like.

## What's on screen

**Live copilot (during the call).** The tree builds in real time and highlights the current path. An agent reads the transcript and surfaces what matters — commitments made, open objections, key facts. Meters track seller confidence and hesitation, and buyer enthusiasm.

**Review (after the call).** Browse your calls, your last *N*, or the whole team's. Replay the exact path. Hover a node for success / EV / signal metrics. Get one-click "practice here" targets aimed at the moments your signals were weakest, plus an ElevenLabs voice walkthrough over an animated replay.

**Mock (practice).** Enter a practice run from any node against an AI buyer — or watch the AI play a perfect rep on both sides. Live transcription, a stop-anywhere breakpoint, and a results view that scrubs the audio synced to its position on the tree.

## Why it's different

Every branch is scored from real outcomes — win-rate rolled into expected value on a green→red spectrum — so a suggestion isn't an opinion, it's "this move closes more." And practice is **targeted by your own weak signals** ("you hesitated at the Tableau objection"), turning a lost call into three specific drills instead of a vague note to improve.

## Scope

Built for a hackathon: **one user, a local JSON store, a single Express process.** The goal is to demo the full loop end-to-end on one seeded call (Convex), not to scale. Live mode is the flashiest piece and the most fragile (STT + LLM latency), so the static tree, review, and mock are the dependable core; live is the stretch.
