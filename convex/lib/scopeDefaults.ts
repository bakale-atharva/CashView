import type { MutationCtx } from "../_generated/server";
import type { ScopeKind } from "./validators";

export const DEFAULT_EXPENSE_CATEGORIES = [
  "Rent",
  "Software",
  "Travel",
  "Meals & Entertainment",
  "Utilities",
  "Marketing",
  "Professional Services",
  "Equipment",
  "Insurance",
  "Payroll",
  "Taxes & Licenses",
  "Bank Fees",
  "Office Supplies",
  "Other",
] as const;

/**
 * Gives a scope its settings document and starter expense categories.
 * Idempotent, so it is safe to call from at-least-once webhook handlers and
 * again lazily from feature code: each half runs only if that half is missing.
 *
 * Uses the raw db on purpose. This is system bookkeeping with no acting user,
 * so it bypasses the audit trigger.
 */
export async function ensureScopeDefaults(
  ctx: Pick<MutationCtx, "db">,
  scope: { scopeId: string; scopeKind: ScopeKind; businessName?: string },
): Promise<void> {
  const { scopeId, scopeKind } = scope;

  const settings = await ctx.db
    .query("scopeSettings")
    .withIndex("by_scopeId", (q) => q.eq("scopeId", scopeId))
    .first();
  if (settings === null) {
    await ctx.db.insert("scopeSettings", {
      scopeId,
      scopeKind,
      businessName: scope.businessName,
      currency: "USD",
      defaultTaxRatePct: 0,
      invoiceNumberPrefix: "INV-",
      nextInvoiceSeq: 1,
      paymentTermsDays: 30,
    });
  }

  const category = await ctx.db
    .query("expenseCategories")
    .withIndex("by_scopeId_and_name", (q) => q.eq("scopeId", scopeId))
    .first();
  if (category === null) {
    for (const name of DEFAULT_EXPENSE_CATEGORIES) {
      await ctx.db.insert("expenseCategories", {
        scopeId,
        scopeKind,
        name,
        isDefault: true,
      });
    }
  }
}
