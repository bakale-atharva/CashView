import { v } from "convex/values";
import { getEntitlements, getUsage } from "./lib/entitlements";
import { scopedQuery } from "./lib/functions";

/** `null` means unlimited, so the client never has to handle Infinity. */
const finiteOrNull = (n: number) => (Number.isFinite(n) ? n : null);

/**
 * Plan, features and usage against the limits, for the UI's meters
 * ("7 of 10 invoices used this month").
 *
 * `now` is passed in because queries must not read the wall clock: it only
 * selects which month the invoice meter shows. It affects display alone. The
 * limits themselves are enforced on every write, against the server's clock.
 */
export const getUsageSummary = scopedQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const entitlements = await getEntitlements(ctx);
    const [clients, invoices] = await Promise.all([
      getUsage(ctx, "clients", now),
      getUsage(ctx, "invoices", now),
    ]);

    // A personal workspace has exactly one member and no roster to count.
    const seatsUsed =
      ctx.scope.scopeKind === "org"
        ? (
            await ctx.db
              .query("memberships")
              .withIndex("by_scopeId_and_clerkUserId", (q) =>
                q.eq("scopeId", ctx.scope.scopeId),
              )
              .take(entitlements.seats + 1)
          ).length
        : 1;

    return {
      plan: entitlements.planKey,
      features: entitlements.features,
      clients: { used: clients, limit: finiteOrNull(entitlements.clients) },
      invoices: { used: invoices, limit: finiteOrNull(entitlements.invoicesPerMonth) },
      seats: { used: seatsUsed, limit: entitlements.seats },
    };
  },
});
