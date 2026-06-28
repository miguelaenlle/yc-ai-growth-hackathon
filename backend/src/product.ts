// product.ts — Shared product context for prompts.
// Used by mock.ts (persona prompt), live.ts (session context), and assist.ts (AssistCard prompt).

import { getCall } from "./store.js";
import type { Id } from "./types.js";

// Keyed by company id. The active demo product is Slack; co_convex is kept for
// legacy seed compatibility.
const PRODUCT_INFO: Record<string, string> = {
  co_slack:
    "Slack is a team messaging and collaboration app — channels, threads, search, " +
    "and integrations that replace internal email and scattered tools. Sold per seat; " +
    "this is a 250-seat, $45k deal. The incumbent is Microsoft Teams.",
  co_convex:
    "Convex is a high-performance backend-as-a-service. It syncs state in real-time, " +
    "guarantees transactional consistency, and is a $48k ACV deal. It integrates with " +
    "any frontend via TypeScript SDK and requires no migration from existing SQL tooling — " +
    "SQL connectors pipe data directly into tools like Tableau.",
};

const DEFAULT_PRODUCT_INFO =
  "A modern SaaS product. Ask the seller for more details.";

/**
 * Return a plain-English product context string for use in AI prompts.
 *
 * Accepts either a company id (`co_slack`) or a call id (`call_hero`). Callers
 * commonly pass `recording.callId`, so when the arg isn't itself a known company
 * id we resolve the call → its company. Falls back to a generic description.
 */
export function getProductInfo(idOrCallId: Id): string {
  if (PRODUCT_INFO[idOrCallId]) return PRODUCT_INFO[idOrCallId];
  const call = getCall(idOrCallId);
  if (call && PRODUCT_INFO[call.companyId]) return PRODUCT_INFO[call.companyId];
  return DEFAULT_PRODUCT_INFO;
}
