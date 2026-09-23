import { useConvexAuth, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Feature } from "@/convex/lib/entitlements";

/** Start of the current UTC month: the only part of `now` the meters use. */
function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * The scope's plan/features/usage (convex/usage.ts — ungated, unlike
 * convex/reports.ts). `now` only selects which calendar month the invoice
 * meter reflects, never a security boundary. It is rounded to the month so
 * every caller passes identical args and shares one subscription.
 */
export function useEntitlements() {
  const { isAuthenticated } = useConvexAuth();
  const [now] = useState(() => monthStart(Date.now()));
  // Skipped until Convex has the Clerk token: the query refuses anonymous
  // callers, and a thrown UNAUTHENTICATED would reach the error boundary.
  return useQuery(api.usage.getUsageSummary, isAuthenticated ? { now } : "skip");
}

/**
 * Whether the active scope's plan (personal or organization) includes a
 * feature; `undefined` while loading. For deciding what to *show* only —
 * the server enforces every gate on its own.
 */
export function useFeature(feature: Feature): boolean | undefined {
  const entitlements = useEntitlements();
  return entitlements?.features.includes(feature);
}
