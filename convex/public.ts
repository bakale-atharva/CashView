import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { MAX_LINES } from "./lib/invoiceMath";
import { looksLikePublicToken } from "./lib/publicToken";
import { getScopeSettings } from "./lib/scopeDefaults";

/**
 * The ONLY unauthenticated functions in the codebase (the Clerk webhook is the
 * one other open endpoint, and it is authenticated by its signature).
 *
 * Read these with care. They deliberately use the raw `db`, since there is no
 * scope to derive: the invoice's public token is the entire capability. Each
 * can reach exactly one invoice, and only if the caller holds its token, which
 * is 256 random bits, so it cannot be guessed or enumerated.
 */

async function findByToken(ctx: QueryCtx, token: string): Promise<Doc<"invoices"> | null> {
  // Anything that is not the right shape cannot be a token: answer without a lookup.
  if (!looksLikePublicToken(token)) return null;
  const invoice = await ctx.db
    .query("invoices")
    .withIndex("by_publicToken", (q) => q.eq("publicToken", token))
    .unique();
  // A draft has no token; this is belt and braces.
  return invoice === null || invoice.status === "draft" ? null : invoice;
}

/**
 * What a client sees when they open the link. A deliberately narrow
 * projection: no ids, no audit history, no scope, no other invoices, and only
 * the client's own name and address. Unknown, malformed and revoked tokens all
 * return the same `null`.
 */
export const getInvoiceByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const invoice = await findByToken(ctx, token);
    if (invoice === null) return null;

    const [client, settings, lines] = await Promise.all([
      ctx.db.get("clients", invoice.clientId),
      getScopeSettings(ctx, invoice.scopeId),
      ctx.db
        .query("invoiceLineItems")
        .withIndex("by_scopeId_and_invoiceId_and_position", (q) =>
          q.eq("scopeId", invoice.scopeId).eq("invoiceId", invoice._id),
        )
        .take(MAX_LINES),
    ]);
    const logoUrl = settings?.logoStorageId
      ? await ctx.storage.getUrl(settings.logoStorageId)
      : null;

    return {
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      discountCents: invoice.discountCents,
      totalCents: invoice.totalCents,
      paidCents: invoice.paidCents,
      balanceCents: invoice.totalCents - invoice.paidCents,
      notes: invoice.notes ?? null,
      sentAt: invoice.sentAt ?? null,
      paidAt: invoice.paidAt ?? null,
      lineItems: lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        taxRatePct: line.taxRatePct,
        amountCents: line.amountCents,
      })),
      // Bill to
      client: client
        ? {
            name: client.name,
            company: client.company ?? null,
            billingAddress: client.billingAddress ?? null,
          }
        : null,
      // Bill from
      seller: {
        businessName: settings?.businessName ?? null,
        address: settings?.address ?? null,
        email: settings?.email ?? null,
        phone: settings?.phone ?? null,
        taxId: settings?.taxId ?? null,
        brandColor: settings?.brandColor ?? null,
        invoiceTemplate: settings?.invoiceTemplate ?? null,
        footerNote: settings?.footerNote ?? null,
        logoUrl,
      },
    };
  },
});

/**
 * Records that the link was opened. Idempotent: the first call moves
 * `sent` to `viewed` and stamps `viewedAt`; every later call changes nothing.
 * Overdue and paid invoices get their `viewedAt` stamped once but keep their
 * status. Anything else (draft, void, unknown token) is ignored.
 *
 * This writes with the raw `db` on purpose. `sent` to `viewed` changes neither
 * the client's balances nor the quota counters, and there is no acting user to
 * attribute an audit row to; `viewedAt` is the record.
 */
export const markViewed = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!looksLikePublicToken(token)) return;
    const invoice = await ctx.db
      .query("invoices")
      .withIndex("by_publicToken", (q) => q.eq("publicToken", token))
      .unique();
    if (invoice === null) return;

    if (invoice.status === "sent") {
      await ctx.db.patch("invoices", invoice._id, {
        status: "viewed",
        viewedAt: Date.now(),
      });
    } else if (
      (invoice.status === "overdue" || invoice.status === "paid") &&
      invoice.viewedAt === undefined
    ) {
      await ctx.db.patch("invoices", invoice._id, { viewedAt: Date.now() });
    }
  },
});
