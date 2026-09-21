import type { DatabaseReader } from "../_generated/server";
import { requireFeature } from "./entitlements";
import type { Scope } from "./validators";

type Ctx = { db: DatabaseReader; scope: Scope };

/** The scope's default currency: what a client without its own uses. */
export async function baseCurrency(ctx: Ctx): Promise<string> {
  const settings = await ctx.db
    .query("scopeSettings")
    .withIndex("by_scopeId", (q) => q.eq("scopeId", ctx.scope.scopeId))
    .first();
  return settings?.currency ?? "USD";
}

/** Invoicing a client in another currency is the Business-tier feature. */
export async function requireCurrencyAllowed(ctx: Ctx, currency: string): Promise<void> {
  if (currency !== (await baseCurrency(ctx))) {
    await requireFeature(ctx, "multi_currency");
  }
}
