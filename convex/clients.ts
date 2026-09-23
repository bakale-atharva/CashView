import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { normalizeClientInput, vClientInput } from "./lib/clientInput";
import { baseCurrency, requireCurrencyAllowed } from "./lib/currency";
import { getInScope, scopedMutation, scopedQuery } from "./lib/functions";
import { requireCapability } from "./lib/scope";
import type { Scope } from "./lib/validators";

/**
 * Client CRUD. Business logic only: scoping, row-level security, the client
 * quota, usage counters and the audit trail all arrive from the scoped
 * builders and their triggers, so none of it is written (or forgotten) here.
 */

type Ctx = { db: DatabaseReader; scope: Scope };

/** The first kind of record that still points at this client, if any. */
async function firstReference(
  ctx: Ctx,
  clientId: Id<"clients">,
): Promise<"invoices" | "payments" | "recurringInvoices" | "expenses" | null> {
  const { scopeId } = ctx.scope;
  if (
    await ctx.db
      .query("invoices")
      .withIndex("by_scopeId_and_clientId_and_issueDate", (q) =>
        q.eq("scopeId", scopeId).eq("clientId", clientId),
      )
      .first()
  ) {
    return "invoices";
  }
  if (
    await ctx.db
      .query("payments")
      .withIndex("by_scopeId_and_clientId", (q) =>
        q.eq("scopeId", scopeId).eq("clientId", clientId),
      )
      .first()
  ) {
    return "payments";
  }
  if (
    await ctx.db
      .query("recurringInvoices")
      .withIndex("by_scopeId_and_clientId", (q) =>
        q.eq("scopeId", scopeId).eq("clientId", clientId),
      )
      .first()
  ) {
    return "recurringInvoices";
  }
  if (
    await ctx.db
      .query("expenses")
      .withIndex("by_scopeId_and_clientId", (q) =>
        q.eq("scopeId", scopeId).eq("clientId", clientId),
      )
      .first()
  ) {
    return "expenses";
  }
  return null;
}

// --- Reads -----------------------------------------------------------------

/**
 * A page of clients, newest first. Archived clients are hidden unless asked
 * for. A search term matches on name and is ranked by relevance instead.
 */
export const list = scopedQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    archived: v.optional(v.boolean()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, { paginationOpts, archived = false, search }) => {
    requireCapability(ctx.scope, "clients.read");

    const term = search?.trim();
    if (term) {
      return await ctx.db
        .query("clients")
        .withSearchIndex("search_name", (q) =>
          q
            .search("name", term)
            .eq("scopeId", ctx.scope.scopeId)
            .eq("isArchived", archived),
        )
        .paginate(paginationOpts);
    }
    return await ctx.db
      .query("clients")
      .withIndex("by_scopeId_and_isArchived", (q) =>
        q.eq("scopeId", ctx.scope.scopeId).eq("isArchived", archived),
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});

/**
 * Live totals across every active client, for the dashboard. Deliberately
 * NOT gated on the `reports` feature: the plan is explicit that caps stop
 * you adding more but never lock you out of seeing what you already have,
 * and "what am I owed right now" is exactly that — unlike the trend/history
 * views in reports.ts, which are the Pro-and-above feature.
 */
export const outstandingSummary = scopedQuery({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "clients.read");
    const currency = await baseCurrency(ctx);
    const clients = await ctx.db
      .query("clients")
      .withIndex("by_scopeId_and_isArchived", (q) =>
        q.eq("scopeId", ctx.scope.scopeId).eq("isArchived", false),
      )
      .take(5000);
    return {
      currency,
      outstandingCents: clients.reduce((s, c) => s + c.outstandingCents, 0),
      clientCount: clients.length,
    };
  },
});

/** One client, including its trigger-maintained balances. */
export const get = scopedQuery({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "clients.read");
    return await getInScope(ctx, "clients", id);
  },
});

/** A client's invoice history, most recently issued first. */
export const listInvoices = scopedQuery({
  args: { clientId: v.id("clients"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { clientId, paginationOpts }) => {
    requireCapability(ctx.scope, "invoices.read");
    await getInScope(ctx, "clients", clientId);
    return await ctx.db
      .query("invoices")
      .withIndex("by_scopeId_and_clientId_and_issueDate", (q) =>
        q.eq("scopeId", ctx.scope.scopeId).eq("clientId", clientId),
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});

// --- Writes ----------------------------------------------------------------

/**
 * Adds a client. Refused with UPGRADE_REQUIRED when the plan's client quota is
 * full; that check lives in the scoped writer, not here.
 */
export const create = scopedMutation({
  args: vClientInput,
  handler: async (ctx, args) => {
    requireCapability(ctx.scope, "clients.write");
    const input = normalizeClientInput(args);

    const currency = input.currency ?? (await baseCurrency(ctx));
    await requireCurrencyAllowed(ctx, currency);

    return await ctx.db.insert("clients", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      name: input.name,
      company: input.company,
      email: input.email,
      phone: input.phone,
      billingAddress: input.billingAddress,
      notes: input.notes,
      currency,
      isArchived: false,
      outstandingCents: 0,
      totalBilledCents: 0,
      totalPaidCents: 0,
    });
  },
});

/**
 * Replaces a client's editable fields. Omitted optional fields are cleared, so
 * send the whole form. Balances and the archived flag are not editable here.
 */
export const update = scopedMutation({
  args: { id: v.id("clients"), ...vClientInput },
  handler: async (ctx, { id, ...args }) => {
    requireCapability(ctx.scope, "clients.write");
    const client = await getInScope(ctx, "clients", id);
    const input = normalizeClientInput(args);

    const currency = input.currency ?? client.currency;
    if (currency !== client.currency) {
      // Invoices are issued and totalled in the client's currency, so it
      // cannot change under them.
      if ((await firstReference(ctx, id)) !== null) {
        throw new ConvexError({
          code: "CONFLICT",
          reason: "client_currency_locked",
        });
      }
      await requireCurrencyAllowed(ctx, currency);
    }

    // Every key is named so an omitted optional field is cleared: a patch only
    // clears a key that is present with the value undefined.
    await ctx.db.patch("clients", id, {
      name: input.name,
      company: input.company,
      email: input.email,
      phone: input.phone,
      billingAddress: input.billingAddress,
      notes: input.notes,
      currency,
    });
  },
});

/** Hides a client from the default list. It still counts toward the quota. */
export const archive = scopedMutation({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "clients.write");
    await getInScope(ctx, "clients", id);
    await ctx.db.patch("clients", id, { isArchived: true });
  },
});

export const unarchive = scopedMutation({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "clients.write");
    await getInScope(ctx, "clients", id);
    await ctx.db.patch("clients", id, { isArchived: false });
  },
});

/**
 * Deletes a client and frees its quota slot. A client that still has
 * invoices, payments, recurring templates or expenses cannot be deleted, since
 * those would be left pointing at nothing and the books would stop adding up;
 * archive it instead.
 */
export const remove = scopedMutation({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "clients.write");
    await getInScope(ctx, "clients", id);

    const blockedBy = await firstReference(ctx, id);
    if (blockedBy !== null) {
      throw new ConvexError({
        code: "CONFLICT",
        reason: "client_has_records",
        blockedBy,
      });
    }
    await ctx.db.delete("clients", id);
  },
});
