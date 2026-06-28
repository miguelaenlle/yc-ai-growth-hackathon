// product.ts — Shared product context for prompts.
// Used by mock.ts (persona prompt), live.ts (session context), and assist.ts (AssistCard prompt).

import type { Id } from "./types.js";

const PRODUCT_INFO: Record<string, string> = {
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
 * Falls back to a generic description for unknown company IDs.
 */
export function getProductInfo(companyId: Id): string {
  return PRODUCT_INFO[companyId] ?? DEFAULT_PRODUCT_INFO;
}
